import fs from "node:fs";
import path from "node:path";
import type { Policy, PolicyStore } from "@lumen/types";

export class InMemoryPolicyStore implements PolicyStore {
  private policies: Map<string, Policy> = new Map();
  private spendTracking: Map<string, Map<string, { dailyTotal: number; txCount: number }>> =
    new Map();
  private velocityTracking: Map<string, number[]> = new Map();

  async getPolicy(walletId: string): Promise<Policy | null> {
    return this.policies.get(walletId) ?? null;
  }

  async listPolicies(): Promise<Policy[]> {
    return Array.from(this.policies.values());
  }

  async savePolicy(policy: Policy): Promise<void> {
    this.policies.set(policy.walletId, policy);
  }

  async deletePolicy(walletId: string): Promise<void> {
    this.policies.delete(walletId);
    this.spendTracking.delete(walletId);
    this.velocityTracking.delete(walletId);
  }

  async recordSpend(
    walletId: string,
    date: string,
    amount: number,
    asset: string = "native",
  ): Promise<{ dailyTotal: number; txCount: number }> {
    if (!this.spendTracking.has(walletId)) {
      this.spendTracking.set(walletId, new Map());
    }
    const walletTrack = this.spendTracking.get(walletId)!;
    const trackKey = `${date}:${asset}`;

    if (!walletTrack.has(trackKey)) {
      walletTrack.set(trackKey, { dailyTotal: 0, txCount: 0 });
    }
    const track = walletTrack.get(trackKey)!;
    track.dailyTotal += amount;
    track.txCount += 1;

    return { dailyTotal: track.dailyTotal, txCount: track.txCount };
  }

  async recordVelocity(walletId: string, timestamp: number, windowMs: number): Promise<number> {
    if (!this.velocityTracking.has(walletId)) {
      this.velocityTracking.set(walletId, []);
    }
    const txTimes = this.velocityTracking.get(walletId)!;
    const cutoff = timestamp - windowMs;
    const recentTxs = txTimes.filter((t) => t > cutoff);
    recentTxs.push(timestamp);
    this.velocityTracking.set(walletId, recentTxs);

    return recentTxs.length;
  }
}

export class FilePolicyStore implements PolicyStore {
  private readonly filePath: string;
  private policies: Map<string, Policy> = new Map();
  private spendTracking: Map<string, Map<string, { dailyTotal: number; txCount: number }>> =
    new Map();
  private velocityTracking: Map<string, number[]> = new Map();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.loadFromFile();
  }

  private loadFromFile(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        if (raw.trim()) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (item && item.walletId) {
                if (item.createdAt && typeof item.createdAt === "string") {
                  item.createdAt = new Date(item.createdAt);
                }
                if (typeof item.version !== "number") {
                  item.version = 1;
                }
                this.policies.set(item.walletId, item);
              }
            }
          } else if (typeof parsed === "object" && parsed !== null) {
            for (const item of Object.values(parsed)) {
              const p = item as Policy;
              if (p && p.walletId) {
                if (p.createdAt && typeof p.createdAt === "string") {
                  p.createdAt = new Date(p.createdAt);
                }
                if (typeof p.version !== "number") {
                  p.version = 1;
                }
                this.policies.set(p.walletId, p);
              }
            }
          }
        }
      }
    } catch {
      // In case of read/parse failure, initialize with empty state
    }
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });

    const tempPath = `${this.filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const data = JSON.stringify(Array.from(this.policies.values()), null, 2);

    await fs.promises.writeFile(tempPath, data, "utf-8");
    await fs.promises.rename(tempPath, this.filePath);
  }

  async getPolicy(walletId: string): Promise<Policy | null> {
    return this.policies.get(walletId) ?? null;
  }

  async listPolicies(): Promise<Policy[]> {
    return Array.from(this.policies.values());
  }

  async savePolicy(policy: Policy): Promise<void> {
    this.policies.set(policy.walletId, policy);
    await this.persist();
  }

  async deletePolicy(walletId: string): Promise<void> {
    this.policies.delete(walletId);
    this.spendTracking.delete(walletId);
    this.velocityTracking.delete(walletId);
    await this.persist();
  }

  async recordSpend(
    walletId: string,
    date: string,
    amount: number,
    asset: string = "native",
  ): Promise<{ dailyTotal: number; txCount: number }> {
    if (!this.spendTracking.has(walletId)) {
      this.spendTracking.set(walletId, new Map());
    }
    const walletTrack = this.spendTracking.get(walletId)!;
    const trackKey = `${date}:${asset}`;

    if (!walletTrack.has(trackKey)) {
      walletTrack.set(trackKey, { dailyTotal: 0, txCount: 0 });
    }
    const track = walletTrack.get(trackKey)!;
    track.dailyTotal += amount;
    track.txCount += 1;

    return { dailyTotal: track.dailyTotal, txCount: track.txCount };
  }

  async recordVelocity(walletId: string, timestamp: number, windowMs: number): Promise<number> {
    if (!this.velocityTracking.has(walletId)) {
      this.velocityTracking.set(walletId, []);
    }
    const txTimes = this.velocityTracking.get(walletId)!;
    const cutoff = timestamp - windowMs;
    const recentTxs = txTimes.filter((t) => t > cutoff);
    recentTxs.push(timestamp);
    this.velocityTracking.set(walletId, recentTxs);

    return recentTxs.length;
  }
}

export interface RedisClientInterface {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  incrbyfloat(key: string, increment: number | string): Promise<string>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number>;
  zcard(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  publish?(channel: string, message: string): Promise<number>;
}

/**
 * Dedicated subscriber connection used for pub/sub. Redis clients in subscriber
 * mode cannot issue regular commands, so this must be a separate connection
 * from the one used by {@link RedisPolicyStore}.
 */
export interface RedisSubscriberInterface {
  subscribe(channel: string, listener: (channel: string, message: string) => void): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: "error" | "end" | "close" | "reconnecting", listener: (...args: unknown[]) => void): unknown;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

export const POLICY_UPDATE_CHANNEL = "lumen:policies:updated";

export interface PolicyUpdateEvent {
  walletId: string;
  action: "save" | "delete";
  timestamp: number;
}

/**
 * Publishes a policy update event so every replica can invalidate its local
 * cache. Best-effort: failures are swallowed (and logged) so they never block
 * or fail the originating API request.
 */
export async function publishPolicyUpdate(
  redis: RedisClientInterface | null | undefined,
  walletId: string,
  action: "save" | "delete" = "save",
): Promise<void> {
  if (!redis || typeof redis.publish !== "function") return;
  const event: PolicyUpdateEvent = { walletId, action, timestamp: Date.now() };
  try {
    await redis.publish(POLICY_UPDATE_CHANNEL, JSON.stringify(event));
  } catch (err) {
    // Best-effort: never propagate publish failures to the caller.
    console.warn(
      `[policy] failed to publish update for wallet ${walletId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export type PolicyInvalidationHandler = (event: PolicyUpdateEvent) => void | Promise<void>;

/**
 * Subscribes to the policy update channel and invokes the registered handler
 * for each event. Automatically re-subscribes when the connection drops.
 */
export class PolicyUpdateSubscriber {
  private readonly subscriber: RedisSubscriberInterface;
  private readonly channel: string;
  private handler: PolicyInvalidationHandler | null = null;
  private subscribed = false;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectDelayMs: number;

  constructor(
    subscriber: RedisSubscriberInterface,
    channel: string = POLICY_UPDATE_CHANNEL,
    reconnectDelayMs: number = 1000,
  ) {
    this.subscriber = subscriber;
    this.channel = channel;
    this.reconnectDelayMs = reconnectDelayMs;
  }

  onInvalidate(handler: PolicyInvalidationHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.closed = false;
    this.subscriber.on("error", (err) => {
      console.warn(
        "[policy] subscriber connection error:",
        err instanceof Error ? err.message : err,
      );
      this.scheduleReconnect();
    });
    this.subscriber.on("end", () => this.scheduleReconnect());
    this.subscriber.on("close", () => this.scheduleReconnect());
    await this.subscribe();
  }

  private async subscribe(): Promise<void> {
    if (this.closed || this.subscribed) return;
    try {
      await this.subscriber.subscribe(this.channel, (_channel, message) => {
        this.handleMessage(message);
      });
      this.subscribed = true;
    } catch (err) {
      console.warn(
        "[policy] failed to subscribe to policy updates:",
        err instanceof Error ? err.message : err,
      );
      this.scheduleReconnect();
    }
  }

  private handleMessage(message: string): void {
    let event: PolicyUpdateEvent;
    try {
      const parsed = JSON.parse(message);
      if (!parsed || typeof parsed.walletId !== "string") return;
      event = {
        walletId: parsed.walletId,
        action: parsed.action === "delete" ? "delete" : "save",
        timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
      };
    } catch {
      return;
    }
    if (!this.handler) return;
    try {
      const result = this.handler(event);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) => {
          console.warn("[policy] invalidation handler failed:", err);
        });
      }
    } catch (err) {
      console.warn("[policy] invalidation handler threw:", err);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.subscribed = false;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.subscribe();
    }, this.reconnectDelayMs);
    // Do not keep the event loop alive solely for reconnection.
    if (typeof this.reconnectTimer === "object" && this.reconnectTimer !== null) {
      (this.reconnectTimer as { unref?: () => void }).unref?.();
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.subscribed) {
      try {
        await this.subscriber.unsubscribe(this.channel);
      } catch {
        // ignore
      }
      this.subscribed = false;
    }
  }
}

export class RedisPolicyStore implements PolicyStore {
  private redis: RedisClientInterface;
  private keyPrefix: string;

  constructor(redisClient: RedisClientInterface, keyPrefix: string = "lumen:") {
    this.redis = redisClient;
    this.keyPrefix = keyPrefix;
  }

  async getPolicy(walletId: string): Promise<Policy | null> {
    const raw = await this.redis.get(`${this.keyPrefix}policy:${walletId}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.createdAt) {
        parsed.createdAt = new Date(parsed.createdAt);
      }
      return parsed as Policy;
    } catch {
      return null;
    }
  }

  async listPolicies(): Promise<Policy[]> {
    const keys = await this.redis.keys(`${this.keyPrefix}policy:*`);
    const policies: Policy[] = [];
    for (const key of keys) {
      const raw = await this.redis.get(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.createdAt) {
          parsed.createdAt = new Date(parsed.createdAt);
        }
        policies.push(parsed as Policy);
      } catch {
        // skip unparseable entries
      }
    }
    return policies;
  }

  async savePolicy(policy: Policy): Promise<void> {
    const key = `${this.keyPrefix}policy:${policy.walletId}`;
    await this.redis.set(key, JSON.stringify(policy));
    // Best-effort broadcast; never blocks or fails the save.
    void publishPolicyUpdate(this.redis, policy.walletId, "save");
  }

  async deletePolicy(walletId: string): Promise<void> {
    const key = `${this.keyPrefix}policy:${walletId}`;
    await this.redis.del(key);
    void publishPolicyUpdate(this.redis, walletId, "delete");
  }

  async recordSpend(
    walletId: string,
    date: string,
    amount: number,
    asset: string = "native",
  ): Promise<{ dailyTotal: number; txCount: number }> {
    const totalKey = `${this.keyPrefix}spend:${walletId}:${asset}:${date}:total`;
    const countKey = `${this.keyPrefix}spend:${walletId}:${asset}:${date}:count`;

    const newTotalStr = await this.redis.incrbyfloat(totalKey, amount);
    const newCount = await this.redis.incr(countKey);

    // Set 48 hour TTL for daily spend keys
    const ttlSeconds = 172800;
    await this.redis.expire(totalKey, ttlSeconds);
    await this.redis.expire(countKey, ttlSeconds);

    return {
      dailyTotal: parseFloat(newTotalStr || "0"),
      txCount: newCount,
    };
  }

  async recordVelocity(walletId: string, timestamp: number, windowMs: number): Promise<number> {
    const key = `${this.keyPrefix}velocity:${walletId}`;
    const cutoff = timestamp - windowMs;
    const member = `${timestamp}-${Math.random().toString(36).substring(2, 9)}`;

    await this.redis.zadd(key, timestamp, member);
    await this.redis.zremrangebyscore(key, "-inf", cutoff);

    const count = await this.redis.zcard(key);

    const ttlSeconds = Math.max(Math.ceil(windowMs / 1000) * 2, 3600);
    await this.redis.expire(key, ttlSeconds);

    return count;
  }
}
