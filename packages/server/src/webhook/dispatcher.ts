import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  WebhookConfig,
  WebhookEventType,
  WebhookPayload,
  WebhookDeliveryResult,
  WebhookDeliveryLogEntry,
} from "@lumen/types";
import { logger } from "../logger.js";

/**
 * Retry schedule for the persistent (BullMQ) delivery pipeline.
 * Each entry is the delay (in milliseconds) applied *before* the next attempt.
 * Attempt 1 happens immediately; the delays below govern attempts 2..6.
 */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [
  60_000, // 1 minute
  5 * 60_000, // 5 minutes
  15 * 60_000, // 15 minutes
  60 * 60_000, // 1 hour
  6 * 60 * 60_000, // 6 hours
];

export const WEBHOOK_QUEUE_NAME = "lumen-webhook-deliveries";
export const WEBHOOK_DLQ_NAME = "lumen-webhook-dead-letter";

/**
 * Minimal structural interfaces for the BullMQ primitives we depend on.
 * Declaring them locally keeps the dispatcher decoupled from a hard
 * `bullmq` import while remaining fully compatible with real instances.
 */
export interface WebhookQueueJobData {
  deliveryId: string;
  webhookId: string;
  url: string;
  secret: string;
  event: WebhookEventType;
  payload: WebhookPayload<unknown>;
  attempt: number;
  lastError?: string;
  lastStatusCode?: number;
}

export interface WebhookQueueLike {
  add(
    name: string,
    data: WebhookQueueJobData,
    opts?: Record<string, unknown>,
  ): Promise<{ id?: string | null }>;
}

export interface WebhookQueueEventsLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface WebhookWorkerLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  close?(): Promise<void>;
}

export interface WebhookRedisLike {
  /** Marker only — any object accepted by BullMQ's connection option works. */
  readonly __lumenRedis?: never;
}

export interface WebhookDeliveryRecord {
  deliveryId: string;
  webhookId: string;
  url: string;
  event: WebhookEventType;
  attempt: number;
  success: boolean;
  statusCode?: number;
  error?: string;
  timestamp: string;
  deliveredAt: string;
  data: unknown;
  /** True once the delivery has been routed to the dead-letter queue. */
  deadLettered?: boolean;
}

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const digest = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : "";
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    return false;
  }

  const receivedDigest = Buffer.from(digest, "hex");
  const expectedDigest = createHmac("sha256", secret).update(payload).digest();
  return (
    receivedDigest.length === expectedDigest.length &&
    timingSafeEqual(receivedDigest, expectedDigest)
  );
}

export interface WebhookDispatcherOpts {
  webhooks?: WebhookConfig[];
  timeoutMs?: number;
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  deliveryLogPath?: string;
  /**
   * Optional BullMQ connection. When provided (together with `queue`), the
   * dispatcher uses the persistent retry pipeline instead of the in-memory
   * retry loop. When omitted, the legacy in-memory/file-log behaviour is used.
   */
  redis?: WebhookRedisLike;
  /** Optional BullMQ queue used to enqueue delivery attempts. */
  queue?: WebhookQueueLike;
  /** Optional BullMQ queue used to persist permanently failed deliveries. */
  deadLetterQueue?: WebhookQueueLike;
  /** Override the retry schedule (primarily for tests). */
  retryDelaysMs?: readonly number[];
  /** Maximum number of delivery log entries to retain. Defaults to 500. */
  maxDeliveryLogSize?: number;
}

export class WebhookDispatcher {
  private webhooks: Map<string, WebhookConfig> = new Map();
  private timeoutMs: number;
  private maxRetries: number;
  private initialDelayMs: number;
  private backoffFactor: number;
  private readonly deliveryLogPath: string;
  private deliveryLogWrite: Promise<void> = Promise.resolve();
  private readonly maxDeliveryLogSize: number;

  private readonly redis?: WebhookRedisLike;
  private readonly queue?: WebhookQueueLike;
  private readonly deadLetterQueue?: WebhookQueueLike;
  private readonly retryDelaysMs: readonly number[];

  constructor(opts: WebhookDispatcherOpts = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.initialDelayMs = opts.initialDelayMs ?? 200;
    this.backoffFactor = opts.backoffFactor ?? 2;
    this.maxDeliveryLogSize = opts.maxDeliveryLogSize ?? 500;
    this.deliveryLogPath =
      opts.deliveryLogPath ??
      process.env.LUMEN_WEBHOOK_DELIVERY_LOG_PATH ??
      path.join(process.cwd(), "data", "webhook-deliveries.jsonl");

    this.redis = opts.redis;
    this.queue = opts.queue;
    this.deadLetterQueue = opts.deadLetterQueue;
    this.retryDelaysMs = opts.retryDelaysMs ?? WEBHOOK_RETRY_DELAYS_MS;

    if (opts.webhooks) {
      for (const wh of opts.webhooks) {
        this.register(wh);
      }
    }
  }

  /** True when the persistent BullMQ retry pipeline is configured. */
  private get usesPersistentQueue(): boolean {
    return Boolean(this.redis && this.queue);
  }

  register(config: WebhookConfig): void {
    this.webhooks.set(config.id, {
      ...config,
      enabled: config.enabled ?? true,
    });
  }

  unregister(id: string): boolean {
    return this.webhooks.delete(id);
  }

  get(id: string): WebhookConfig | undefined {
    return this.webhooks.get(id);
  }

  list(): WebhookConfig[] {
    return Array.from(this.webhooks.values());
  }

  /**
   * Partially update an existing webhook registration.
   * Returns the updated `WebhookConfig`, or `null` if the id is not found.
   */
  update(id: string, updates: Partial<Omit<WebhookConfig, "id">>): WebhookConfig | null {
    const existing = this.webhooks.get(id);
    if (!existing) return null;
    const updated: WebhookConfig = { ...existing, ...updates, id };
    this.webhooks.set(id, updated);
    return updated;
  }

  /**
   * Dispatch a synthetic `test.ping` event to a specific webhook by id.
   * Returns a delivery summary describing the single attempt.
   */
  async sendTest(id: string): Promise<{
    success: boolean;
    statusCode?: number;
    attempts: number;
    responseTimeMs: number;
  }> {
    const wh = this.webhooks.get(id);
    if (!wh) throw new Error(`Webhook not found: ${id}`);

    const payload = {
      id: randomUUID(),
      event: "test.ping" as WebhookEventType,
      timestamp: new Date().toISOString(),
      data: { message: "This is a test delivery from the Lumen webhook system." },
    };
    const body = JSON.stringify(payload);
    const signature = this.generateSignature(body, wh.secret);

    const startTime = Date.now();
    let statusCode: number | undefined;
    let success = false;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(wh.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Lumen-Signature": signature,
          "X-Lumen-Event": "test.ping",
          "X-Lumen-Delivery": payload.id,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);
      statusCode = res.status;
      success = res.ok;
    } catch {
      success = false;
    }

    const responseTimeMs = Date.now() - startTime;
    return { success, statusCode, attempts: 1, responseTimeMs };
  }

  /**
   * List all persisted delivery attempts for a given webhook, newest first.
   * Returns an empty array when the webhook has no recorded deliveries.
   */
  async listDeliveries(webhookId: string): Promise<WebhookDeliveryRecord[]> {
    const entries = await this.getDeliveryLog();
    return entries
      .filter((entry) => entry.webhookId === webhookId)
      .map((entry) => this.toDeliveryRecord(entry))
      .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt));
  }

  /**
   * Re-enqueue a previously failed delivery for another attempt.
   * Returns the updated delivery record, or `null` if the delivery is unknown.
   */
  async retryDelivery(deliveryId: string): Promise<WebhookDeliveryRecord | null> {
    const entries = await this.getDeliveryLog();
    const matching = entries.filter((entry) => entry.deliveryId === deliveryId);
    if (matching.length === 0) {
      return null;
    }

    const latest = matching[matching.length - 1];
    const webhook = this.webhooks.get(latest.webhookId);
    if (!webhook) {
      logger.warn(
        { deliveryId, webhookId: latest.webhookId },
        "Cannot retry delivery: webhook no longer registered",
      );
      return null;
    }

    const payload: WebhookPayload<unknown> = {
      id: deliveryId,
      event: latest.event,
      timestamp: latest.timestamp,
      data: latest.data,
    };

    const result = await this.attemptDelivery(webhook, payload, 1);

    const record: WebhookDeliveryRecord = {
      deliveryId,
      webhookId: webhook.id,
      url: webhook.url,
      event: latest.event,
      attempt: 1,
      success: result.success,
      statusCode: result.statusCode,
      error: result.error,
      timestamp: payload.timestamp,
      deliveredAt: new Date().toISOString(),
      data: payload.data,
      deadLettered: false,
    };

    await this.persistDeliveryLog([
      {
        webhookId: record.webhookId,
        url: record.url,
        success: record.success,
        statusCode: record.statusCode,
        attempts: record.attempt,
        error: record.error,
        deliveryId: record.deliveryId,
        event: record.event,
        timestamp: record.timestamp,
        deliveredAt: record.deliveredAt,
        data: record.data,
      },
    ]);

    if (!result.success) {
      await this.routeToDeadLetter(record, result.error);
    }

    return record;
  }

  async getDeliveryLog(): Promise<WebhookDeliveryLogEntry[]> {
    let contents: string;
    try {
      contents = await fs.promises.readFile(this.deliveryLogPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    return contents
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as WebhookDeliveryLogEntry);
  }

  private async persistDeliveryLog(entries: WebhookDeliveryLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const write = this.deliveryLogWrite.then(async () => {
      await fs.promises.mkdir(path.dirname(this.deliveryLogPath), {
        recursive: true,
        mode: 0o700,
      });

      let existingEntries: WebhookDeliveryLogEntry[] = [];
      try {
        const contents = await fs.promises.readFile(this.deliveryLogPath, "utf8");
        existingEntries = contents
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as WebhookDeliveryLogEntry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const combined = [...existingEntries, ...entries];
      const capped =
        this.maxDeliveryLogSize > 0 && combined.length > this.maxDeliveryLogSize
          ? combined.slice(combined.length - this.maxDeliveryLogSize)
          : combined;

      const lines = capped.map((entry) => JSON.stringify(entry)).join("\n");
      const tempPath = `${this.deliveryLogPath}.${randomUUID()}.tmp`;
      await fs.promises.writeFile(tempPath, lines.length > 0 ? `${lines}\n` : "", {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.promises.rename(tempPath, this.deliveryLogPath);
    });
    this.deliveryLogWrite = write.catch((error: unknown) => {
      logger.error({ error }, "Failed to persist webhook delivery log");
    });
    await write;
  }

  generateSignature(payload: string, secret: string): string {
    const hmac = createHmac("sha256", secret);
    hmac.update(payload);
    return `sha256=${hmac.digest("hex")}`;
  }

  createPayload<T>(event: WebhookEventType, data: T): WebhookPayload<T> {
    return {
      id: randomUUID(),
      event,
      timestamp: new Date().toISOString(),
      data,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private toDeliveryRecord(entry: WebhookDeliveryLogEntry): WebhookDeliveryRecord {
    return {
      deliveryId: entry.deliveryId,
      webhookId: entry.webhookId,
      url: entry.url,
      event: entry.event,
      attempt: entry.attempts,
      success: entry.success,
      statusCode: entry.statusCode,
      error: entry.error,
      timestamp: entry.timestamp,
      deliveredAt: entry.deliveredAt,
      data: entry.data,
    };
  }

  /**
   * Perform a single delivery attempt against a webhook endpoint.
   */
  private async attemptDelivery(
    webhook: WebhookConfig,
    payload: WebhookPayload<unknown>,
    attempt: number,
  ): Promise<WebhookDeliveryResult> {
    const body = JSON.stringify(payload);
    const signature = this.generateSignature(body, webhook.secret);

    let statusCode: number | undefined;
    let error: string | undefined;
    let success = false;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Lumen-Signature": signature,
          "X-Lumen-Event": payload.event,
          "X-Lumen-Delivery": payload.id,
          "X-Lumen-Attempt": String(attempt),
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);
      statusCode = res.status;
      success = res.ok;
      if (!success) {
        error = `HTTP ${res.status}: ${res.statusText}`;
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
    }

    return {
      webhookId: webhook.id,
      url: webhook.url,
      success,
      statusCode,
      attempts: attempt,
      error: success ? undefined : error,
    } as WebhookDeliveryResult;
  }

  /**
   * Route a permanently failed delivery to the dead-letter queue (when
   * configured) and log the failure for the audit trail.
   */
  private async routeToDeadLetter(
    record: WebhookDeliveryRecord,
    lastError?: string,
  ): Promise<void> {
    logger.error(
      {
        deliveryId: record.deliveryId,
        webhookId: record.webhookId,
        attempts: record.attempt,
        error: lastError ?? record.error,
      },
      "Webhook delivery exhausted retries; routing to dead-letter queue",
    );

    if (!this.deadLetterQueue) {
      return;
    }

    try {
      await this.deadLetterQueue.add(
        "dead-letter",
        {
          deliveryId: record.deliveryId,
          webhookId: record.webhookId,
          url: record.url,
          secret: "",
          event: record.event,
          payload: {
            id: record.deliveryId,
            event: record.event,
            timestamp: record.timestamp,
            data: record.data,
          },
          attempt: record.attempt,
          lastError: lastError ?? record.error,
          lastStatusCode: record.statusCode,
        },
        {
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
    } catch (err: unknown) {
      logger.error(
        { error: err, deliveryId: record.deliveryId },
        "Failed to enqueue webhook delivery to dead-letter queue",
      );
    }
  }

  /**
   * Enqueue a delivery attempt on the persistent BullMQ queue with the
   * appropriate custom backoff delay for the given attempt number.
   */
  private async enqueueAttempt(
    webhook: WebhookConfig,
    payload: WebhookPayload<unknown>,
    attempt: number,
    lastError?: string,
    lastStatusCode?: number,
  ): Promise<void> {
    if (!this.queue) return;

    const delay = attempt > 1 ? this.retryDelaysMs[attempt - 2] ?? 0 : 0;

    await this.queue.add(
      "deliver",
      {
        deliveryId: payload.id,
        webhookId: webhook.id,
        url: webhook.url,
        secret: webhook.secret,
        event: payload.event,
        payload,
        attempt,
        lastError,
        lastStatusCode,
      },
      {
        delay,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: false,
        jobId: `${payload.id}:${attempt}`,
      },
    );
  }

  async dispatch<T>(event: WebhookEventType, data: T): Promise<WebhookDeliveryResult[]> {
    const matchingWebhooks = Array.from(this.webhooks.values()).filter(
      (wh) => wh.enabled !== false && (wh.events.includes(event) || wh.events.includes("*")),
    );

    if (matchingWebhooks.length === 0) {
      return [];
    }

    const payload = this.createPayload(event, data);

    if (this.usesPersistentQueue) {
      return this.dispatchPersistent(matchingWebhooks, payload);
    }

    const deliveryPromises = matchingWebhooks.map(async (wh) => {
      let attempts = 0;
      let lastStatusCode: number | undefined;
      let lastError: string | undefined;
      let success = false;

      while (attempts <= this.maxRetries) {
        attempts++;
        const result = await this.attemptDelivery(wh, payload, attempts);
        lastStatusCode = result.statusCode;

        if (result.success) {
          success = true;
          break;
        }

        lastError = result.error;

        // If client error (other than 429 Too Many Requests), do not retry
        if (
          lastStatusCode !== undefined &&
          lastStatusCode >= 400 &&
          lastStatusCode < 500 &&
          lastStatusCode !== 429
        ) {
          break;
        }

        if (attempts <= this.maxRetries) {
          const delay = this.initialDelayMs * Math.pow(this.backoffFactor, attempts - 1);
          await this.sleep(delay);
        }
      }

      if (!success) {
        logger.warn(
          { webhookId: wh.id, attempts, error: lastError },
          "Webhook delivery failed after attempts",
        );
      }

      return {
        webhookId: wh.id,
        url: wh.url,
        success,
        statusCode: lastStatusCode,
        attempts,
        error: success ? undefined : lastError,
      } as WebhookDeliveryResult;
    });

    const results = await Promise.all(deliveryPromises);
    const deliveredAt = new Date().toISOString();
    await this.persistDeliveryLog(
      results.map((result) => ({
        ...result,
        deliveryId: payload.id,
        event,
        timestamp: payload.timestamp,
        deliveredAt,
        data: payload.data,
      })),
    );

    return results;
  }

  /**
   * Persistent delivery path: enqueue the first attempt on the BullMQ queue.
   * Subsequent attempts are scheduled by the worker via `processQueueJob`.
   * The returned results describe the enqueue outcome (attempt 1 pending).
   */
  private async dispatchPersistent(
    webhooks: WebhookConfig[],
    payload: WebhookPayload<unknown>,
  ): Promise<WebhookDeliveryResult[]> {
    const deliveredAt = new Date().toISOString();
    const results: WebhookDeliveryResult[] = [];

    for (const wh of webhooks) {
      try {
        await this.enqueueAttempt(wh, payload, 1);
        results.push({
          webhookId: wh.id,
          url: wh.url,
          success: true,
          attempts: 1,
          error: undefined,
        } as WebhookDeliveryResult);
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error(
          { error, webhookId: wh.id, deliveryId: payload.id },
          "Failed to enqueue webhook delivery",
        );
        results.push({
          webhookId: wh.id,
          url: wh.url,
          success: false,
          attempts: 0,
          error,
        } as WebhookDeliveryResult);
      }
    }

    await this.persistDeliveryLog(
      results.map((result) => ({
        ...result,
        deliveryId: payload.id,
        event: payload.event,
        timestamp: payload.timestamp,
        deliveredAt,
        data: payload.data,
      })),
    );

    return results;
  }

  /**
   * Process a single job pulled from the BullMQ queue by a worker.
   * Performs one delivery attempt, persists the attempt, and either schedules
   * the next retry (with the configured backoff) or routes the delivery to
   * the dead-letter queue once the retry schedule is exhausted.
   */
  async processQueueJob(data: WebhookQueueJobData): Promise<WebhookDeliveryRecord> {
    const webhook = this.webhooks.get(data.webhookId);
    const deliveredAt = new Date().toISOString();

    if (!webhook) {
      const record: WebhookDeliveryRecord = {
        deliveryId: data.deliveryId,
        webhookId: data.webhookId,
        url: data.url,
        event: data.event,
        attempt: data.attempt,
        success: false,
        error: `Webhook not found: ${data.webhookId}`,
        timestamp: data.payload.timestamp,
        deliveredAt,
        data: data.payload.data,
        deadLettered: true,
      };
      await this.persistDeliveryLog([
        {
          webhookId: record.webhookId,
          url: record.url,
          success: false,
          statusCode: undefined,
          attempts: record.attempt,
          error: record.error,
          deliveryId: record.deliveryId,
          event: record.event,
          timestamp: record.timestamp,
          deliveredAt: record.deliveredAt,
          data: record.data,
        },
      ]);
      await this.routeToDeadLetter(record, record.error);
      return record;
    }

    const result = await this.attemptDelivery(webhook, data.payload, data.attempt);

    const record: WebhookDeliveryRecord = {
      deliveryId: data.deliveryId,
      webhookId: webhook.id,
      url: webhook.url,
      event: data.event,
      attempt: data.attempt,
      success: result.success,
      statusCode: result.statusCode,
      error: result.error,
      timestamp: data.payload.timestamp,
      deliveredAt,
      data: data.payload.data,
      deadLettered: false,
    };

    await this.persistDeliveryLog([
      {
        webhookId: record.webhookId,
        url: record.url,
        success: record.success,
        statusCode: record.statusCode,
        attempts: record.attempt,
        error: record.error,
        deliveryId: record.deliveryId,
        event: record.event,
        timestamp: record.timestamp,
        deliveredAt: record.deliveredAt,
        data: record.data,
      },
    ]);

    if (result.success) {
      return record;
    }

    const isClientError =
      result.statusCode !== undefined &&
      result.statusCode >= 400 &&
      result.statusCode < 500 &&
      result.statusCode !== 429;

    const maxAttempts = this.retryDelaysMs.length + 1;
    const canRetry = !isClientError && data.attempt < maxAttempts;

    if (canRetry) {
      await this.enqueueAttempt(
        webhook,
        data.payload,
        data.attempt + 1,
        result.error,
        result.statusCode,
      );
    } else {
      record.deadLettered = true;
      await this.routeToDeadLetter(record, result.error);
    }

    return record;
  }
}
