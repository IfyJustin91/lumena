import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  WebhookDispatcher,
  type WebhookDispatcherOpts,
  verifyWebhookSignature,
} from "../webhook/dispatcher.js";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("WebhookDispatcher Unit Tests", () => {
  const secret = "test-webhook-secret-key";
  let tempDir: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-webhook-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const createDispatcher = (opts: WebhookDispatcherOpts = {}): WebhookDispatcher =>
    new WebhookDispatcher({
      ...opts,
      deliveryLogPath: path.join(tempDir, "deliveries.jsonl"),
    });

  it("registers, lists, and unregisters webhook configurations", () => {
    const dispatcher = createDispatcher();
    dispatcher.register({
      id: "wh-1",
      url: "https://example.com/webhook",
      secret,
      events: ["transaction.cosigned"],
    });

    expect(dispatcher.list()).toHaveLength(1);
    expect(dispatcher.get("wh-1")?.url).toBe("https://example.com/webhook");

    const deleted = dispatcher.unregister("wh-1");
    expect(deleted).toBe(true);
    expect(dispatcher.list()).toHaveLength(0);
  });

  it("generates correct HMAC-SHA256 signature", () => {
    const dispatcher = createDispatcher();
    const payload = JSON.stringify({ hello: "world" });
    const sig = dispatcher.generateSignature(payload, secret);

    const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    expect(sig).toBe(expected);
  });

  it("verifies webhook signatures and rejects mismatched or malformed signatures", () => {
    const dispatcher = new WebhookDispatcher();
    const payload = JSON.stringify({ event: "transaction.cosigned" });
    const signature = dispatcher.generateSignature(payload, secret);

    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(`${payload} `, signature, secret)).toBe(false);
    expect(verifyWebhookSignature(payload, signature, "wrong-secret")).toBe(false);
    expect(verifyWebhookSignature(payload, "not-a-signature", secret)).toBe(false);
    expect(verifyWebhookSignature(payload, `sha256=${"a".repeat(63)}`, secret)).toBe(false);
  });

  it("filters events by webhook subscriptions and supports wildcards", async () => {
    const dispatcher = createDispatcher({ timeoutMs: 1000, maxRetries: 0 });

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock;

    dispatcher.register({
      id: "wh-cosign-only",
      url: "https://example.com/cosign",
      secret,
      events: ["transaction.cosigned"],
    });

    dispatcher.register({
      id: "wh-all",
      url: "https://example.com/all",
      secret,
      events: ["*"],
    });

    // Dispatch an event only wh-all listens to
    await dispatcher.dispatch("balance.low", { balance: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/all",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Lumen-Event": "balance.low",
        }),
      }),
    );

    // Dispatch cosigned event -> both should receive
    fetchMock.mockClear();
    await dispatcher.dispatch("transaction.cosigned", { txHash: "1234" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    await dispatcher.dispatch("transaction.fee_bump.submitted", { hash: "fee-bump-hash" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/all",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Lumen-Event": "transaction.fee_bump.submitted",
        }),
      }),
    );
  });

  it("dispatches wallet.created to matching webhook subscriptions", async () => {
    const dispatcher = createDispatcher({ maxRetries: 0 });
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock;

    dispatcher.register({
      id: "wh-wallet-created",
      url: "https://example.com/wallets",
      secret,
      events: ["wallet.created"],
    });

    const results = await dispatcher.dispatch("wallet.created", {
      address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    });

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/wallets",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Lumen-Event": "wallet.created" }),
      }),
    );
  });

  it("retries failed deliveries up to maxRetries on 500 error", async () => {
    const dispatcher = createDispatcher({
      timeoutMs: 500,
      maxRetries: 2,
      initialDelayMs: 10,
      backoffFactor: 1.5,
    });

    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response("OK", { status: 200 });
    });

    dispatcher.register({
      id: "wh-retry",
      url: "https://example.com/retry",
      secret,
      events: ["transaction.sponsored"],
    });

    const results = await dispatcher.dispatch("transaction.sponsored", { hash: "abc" });
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it("does not retry on 4xx client errors (e.g. 400 Bad Request)", async () => {
    const dispatcher = createDispatcher({
      timeoutMs: 500,
      maxRetries: 3,
      initialDelayMs: 10,
    });

    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      return new Response("Bad Request", { status: 400 });
    });

    dispatcher.register({
      id: "wh-400",
      url: "https://example.com/400",
      secret,
      events: ["*"],
    });

    const results = await dispatcher.dispatch("transaction.sponsored", { hash: "abc" });
    expect(results[0].success).toBe(false);
    expect(results[0].attempts).toBe(1);
    expect(calls).toBe(1);
    await expect(dispatcher.getDeliveryLog()).resolves.toMatchObject([
      { success: false, attempts: 1, error: "HTTP 400: " },
    ]);
  });

  it("retries on 429 Too Many Requests error", async () => {
    const dispatcher = createDispatcher({
      timeoutMs: 500,
      maxRetries: 2,
      initialDelayMs: 10,
    });

    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        return new Response("Too Many Requests", { status: 429 });
      }
      return new Response("OK", { status: 200 });
    });

    dispatcher.register({
      id: "wh-429",
      url: "https://example.com/429",
      secret,
      events: ["*"],
    });

    const results = await dispatcher.dispatch("transaction.sponsored", { hash: "abc" });
    expect(results[0].success).toBe(true);
    expect(results[0].attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it("verifies backoff delay grows exponentially", async () => {
    const dispatcher = createDispatcher({
      timeoutMs: 500,
      maxRetries: 3,
      initialDelayMs: 100,
      backoffFactor: 2,
    });

    const timestamps: number[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      timestamps.push(Date.now());
      return new Response("Internal Server Error", { status: 500 });
    });

    dispatcher.register({
      id: "wh-backoff",
      url: "https://example.com/backoff",
      secret,
      events: ["*"],
    });

    const startTime = Date.now();
    await dispatcher.dispatch("transaction.sponsored", { hash: "abc" });
    const totalTime = Date.now() - startTime;

    // With maxRetries=3, we make 4 attempts total
    // Delays should be: 0ms (first attempt), 100ms, 200ms, 400ms
    // Total minimum time should be around 700ms
    expect(timestamps).toHaveLength(4);
    expect(totalTime).toBeGreaterThanOrEqual(600); // Allow some margin
  });

  it("schedules retries at 1m, 5m, 15m, 1h, and 6h on 500 responses", async () => {
    const dispatcher = createDispatcher({ timeoutMs: 500 });
    const fetchMock = vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 }));
    globalThis.fetch = fetchMock;

    dispatcher.register({
      id: "wh-pipeline",
      url: "https://example.com/pipeline",
      secret,
      events: ["transaction.cosigned"],
    });

    const results = await dispatcher.dispatch("transaction.cosigned", { txHash: "abc" });
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);

    const deliveries = await dispatcher.listDeliveries("wh-pipeline");
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0];
    expect(delivery.status).toBe("pending");
    expect(delivery.attempts).toBe(1);
    expect(delivery.lastError).toBe("HTTP 500: Internal Server Error");

    const expectedDelays = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];
    expect(delivery.retrySchedule).toEqual(expectedDelays);
    expect(delivery.nextRetryAt).toBeTruthy();
    expect(delivery.nextRetryAt! - delivery.timestamp).toBeGreaterThanOrEqual(expectedDelays[0] - 1000);
  });

  it("moves exhausted deliveries to the dead-letter queue with the last error persisted", async () => {
    const dispatcher = createDispatcher({ timeoutMs: 500 });
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      return new Response(`failure-${calls}`, { status: 500 });
    });

    dispatcher.register({
      id: "wh-dlq",
      url: "https://example.com/dlq",
      secret,
      events: ["*"],
    });

    const results = await dispatcher.dispatch("transaction.cosigned", { txHash: "dlq" });
    expect(results).toHaveLength(1);
    const deliveryId = results[0].deliveryId;

    // Simulate the retry pipeline exhausting all scheduled retries.
    for (let i = 0; i < 5; i++) {
      await dispatcher.processRetry(deliveryId);
    }

    const dlq = await dispatcher.listDeadLetters();
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toMatchObject({
      deliveryId,
      webhookId: "wh-dlq",
      status: "dead",
      attempts: 6,
      lastError: "HTTP 500: failure-6",
    });
    expect(dlq[0].deadLetteredAt).toBeTruthy();

    const deliveries = await dispatcher.listDeliveries("wh-dlq");
    expect(deliveries[0].status).toBe("dead");
    expect(deliveries[0].lastError).toBe("HTTP 500: failure-6");
  });

  it("lists deliveries per webhook and retries a dead-lettered delivery on demand", async () => {
    const dispatcher = createDispatcher({ timeoutMs: 500 });
    let shouldFail = true;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      if (shouldFail) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response("OK", { status: 200 });
    });

    dispatcher.register({
      id: "wh-manual",
      url: "https://example.com/manual",
      secret,
      events: ["*"],
    });
    dispatcher.register({
      id: "wh-other",
      url: "https://example.com/other",
      secret,
      events: ["*"],
    });

    const results = await dispatcher.dispatch("transaction.cosigned", { txHash: "manual" });
    const deliveryId = results[0].deliveryId;

    for (let i = 0; i < 5; i++) {
      await dispatcher.processRetry(deliveryId);
    }

    const manualDeliveries = await dispatcher.listDeliveries("wh-manual");
    expect(manualDeliveries).toHaveLength(1);
    expect(manualDeliveries[0].status).toBe("dead");

    const otherDeliveries = await dispatcher.listDeliveries("wh-other");
    expect(otherDeliveries).toHaveLength(1);
    expect(otherDeliveries[0].deliveryId).not.toBe(deliveryId);

    shouldFail = false;
    const retried = await dispatcher.retryDelivery(deliveryId);
    expect(retried.success).toBe(true);
    expect(retried.status).toBe("delivered");

    const afterRetry = await dispatcher.listDeliveries("wh-manual");
    expect(afterRetry[0].status).toBe("delivered");
    expect(await dispatcher.listDeadLetters()).toHaveLength(0);

    await expect(dispatcher.retryDelivery("missing-delivery")).rejects.toThrow();
  });

  it("persists delivery history and reloads it from a new dispatcher", async () => {
    const logPath = path.join(tempDir, "persistent-deliveries.jsonl");
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock;

    const dispatcher = new WebhookDispatcher({
      maxRetries: 0,
      deliveryLogPath: logPath,
      webhooks: [
        {
          id: "wh-persistent",
          url: "https://example.com/persistent",
          secret,
          events: ["transaction.cosigned"],
        },
      ],
    });
    const results = await dispatcher.dispatch("transaction.cosigned", { txHash: "abc" });

    const restartedDispatcher = new WebhookDispatcher({ deliveryLogPath: logPath });
    const history = await restartedDispatcher.getDeliveryLog();

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      webhookId: results[0].webhookId,
      url: results[0].url,
      success: results[0].success,
      statusCode: results[0].statusCode,
      attempts: results[0].attempts,
      event: "transaction.cosigned",
      data: { txHash: "abc" },
    });
    expect(history[0].deliveryId).toBeTruthy();
    expect(history[0].timestamp).toBeTruthy();
    expect(history[0].deliveredAt).toBeTruthy();
    expect(JSON.stringify(history)).not.toContain(secret);
  });

  it("caps delivery log to maxDeliveryLogSize and evicts oldest entries", async () => {
    const logPath = path.join(tempDir, "capped-deliveries.jsonl");
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock;

    const dispatcher = new WebhookDispatcher({
      maxRetries: 0,
      deliveryLogPath: logPath,
      maxDeliveryLogSize: 500,
      webhooks: [
        {
          id: "wh-capped",
          url: "https://example.com/capped",
          secret,
          events: ["transaction.sponsored"],
        },
      ],
    });

    for (let i = 0; i < 600; i++) {
      await dispatcher.dispatch("transaction.sponsored", { index: i });
    }

    const log = await dispatcher.getDeliveryLog();
    expect(log).toHaveLength(500);
    // Oldest 100 entries (indices 0..99) should be evicted; entries remaining should start from index 100
    expect((log[0].data as { index: number }).index).toBe(100);
    expect((log[499].data as { index: number }).index).toBe(599);
  });
});
