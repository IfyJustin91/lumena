import { randomUUID } from 'crypto';

/**
 * Minimal structural interface for a Redis client so we can support
 * `ioredis` (and compatible clients) without a hard runtime dependency,
 * while still allowing an in-memory fallback for tests.
 */
export interface RedisLike {
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

/**
 * Minimal structural interface for a Redlock-compatible lock manager.
 */
export interface RedlockLike {
  acquire(
    resources: string[],
    ttl: number,
  ): Promise<{ release(): Promise<void> }>;
}

export interface SequenceNumberAllocatorOptions {
  /** Redis client used for atomic reservations. When omitted, an in-memory allocator is used. */
  redis?: RedisLike | null;
  /** Optional Redlock instance for cross-process coordination. */
  redlock?: RedlockLike | null;
  /** TTL (ms) for a reservation before it is considered abandoned. Default: 30_000. */
  reservationTtlMs?: number;
  /** Base delay (ms) for exponential backoff on txBAD_SEQ. Default: 50. */
  baseBackoffMs?: number;
  /** Maximum number of retry attempts on txBAD_SEQ. Default: 8. */
  maxRetries?: number;
  /** Maximum backoff delay (ms). Default: 5_000. */
  maxBackoffMs?: number;
  /** Optional clock injection for deterministic tests. */
  now?: () => number;
  /** Optional sleep injection for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SequenceReservation {
  account: string;
  sequence: number;
  reservationId: string;
  /** Release the reservation if it was never consumed. */
  rollback(): Promise<void>;
  /** Mark the reservation as consumed so it is not rolled back. */
  commit(): Promise<void>;
}

export interface SequenceNumberAllocator {
  /**
   * Atomically reserve the next sequence number for `account`.
   */
  reserve(account: string): Promise<SequenceReservation>;

  /**
   * Roll back an unused reservation, returning the sequence number to the pool
   * where possible.
   */
  rollback(account: string, reservationId: string): Promise<void>;

  /**
   * Reserve a sequence number, run `fn`, and retry with exponential backoff
   * when Horizon reports a `txBAD_SEQ` collision.
   */
  withSequence<T>(
    account: string,
    fn: (sequence: number) => Promise<T>,
  ): Promise<T>;
}

const RESERVATION_PREFIX = 'lumen:seq:reservation:';
const COUNTER_PREFIX = 'lumen:seq:counter:';
const LOCK_PREFIX = 'lumen:seq:lock:';

const DEFAULT_RESERVATION_TTL_MS = 30_000;
const DEFAULT_BASE_BACKOFF_MS = 50;
const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_MAX_BACKOFF_MS = 5_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTxBadSeqError(error: unknown): boolean {
  if (!error) return false;
  const message =
    typeof error === 'string'
      ? error
      : typeof (error as { message?: unknown }).message === 'string'
        ? ((error as { message: string }).message as string)
        : '';
  const code =
    typeof (error as { code?: unknown }).code === 'string'
      ? ((error as { code: string }).code as string)
      : '';
  const responseCode =
    typeof (error as { response?: { data?: { extras?: { result_codes?: { transaction?: string } } } } })
      .response?.data?.extras?.result_codes?.transaction === 'string'
      ? (error as {
          response: {
            data: { extras: { result_codes: { transaction: string } } };
          };
        }).response.data.extras.result_codes.transaction
      : '';

  return (
    code === 'txBAD_SEQ' ||
    responseCode === 'txBAD_SEQ' ||
    /txBAD_SEQ/.test(message) ||
    /bad[_\s-]?seq/i.test(message)
  );
}

function computeBackoff(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseMs;
  return Math.min(maxMs, exponential + jitter);
}

/**
 * Redis-backed allocator using atomic INCR plus reservation TTL keys.
 */
class RedisSequenceNumberAllocator implements SequenceNumberAllocator {
  private readonly redis: RedisLike;
  private readonly redlock: RedlockLike | null;
  private readonly reservationTtlMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxRetries: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SequenceNumberAllocatorOptions & { redis: RedisLike }) {
    this.redis = options.redis;
    this.redlock = options.redlock ?? null;
    this.reservationTtlMs =
      options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async reserve(account: string): Promise<SequenceReservation> {
    const reservationId = randomUUID();
    const counterKey = `${COUNTER_PREFIX}${account}`;
    const reservationKey = `${RESERVATION_PREFIX}${account}:${reservationId}`;

    const run = async (): Promise<number> => {
      const sequence = await this.redis.incr(counterKey);
      await this.redis.set(
        reservationKey,
        String(sequence),
        'PX',
        this.reservationTtlMs,
      );
      return sequence;
    };

    let sequence: number;
    if (this.redlock) {
      const lock = await this.redlock.acquire(
        [`${LOCK_PREFIX}${account}`],
        Math.max(this.reservationTtlMs, 1_000),
      );
      try {
        sequence = await run();
      } finally {
        await lock.release().catch(() => undefined);
      }
    } else {
      sequence = await run();
    }

    let settled = false;
    return {
      account,
      sequence,
      reservationId,
      rollback: async () => {
        if (settled) return;
        settled = true;
        await this.rollback(account, reservationId);
      },
      commit: async () => {
        if (settled) return;
        settled = true;
        await this.redis.del(reservationKey).catch(() => 0);
      },
    };
  }

  async rollback(account: string, reservationId: string): Promise<void> {
    const reservationKey = `${RESERVATION_PREFIX}${account}:${reservationId}`;
    const counterKey = `${COUNTER_PREFIX}${account}`;

    // Only roll back if the reservation still exists (i.e. was not consumed
    // and has not expired). Use a Lua script for atomic check-and-decrement.
    const script = `
      local reservation = redis.call('GET', KEYS[1])
      if not reservation then
        return 0
      end
      redis.call('DEL', KEYS[1])
      local current = tonumber(redis.call('GET', KEYS[2]) or '0')
      local reserved = tonumber(reservation)
      if current == reserved then
        redis.call('DECR', KEYS[2])
        return 1
      end
      return 0
    `;

    try {
      await this.redis.eval(script, 2, reservationKey, counterKey);
    } catch {
      // Best-effort rollback; ignore failures.
    }
  }

  async withSequence<T>(
    account: string,
    fn: (sequence: number) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const reservation = await this.reserve(account);
      try {
        const result = await fn(reservation.sequence);
        await reservation.commit();
        return result;
      } catch (error) {
        await reservation.rollback().catch(() => undefined);
        if (!isTxBadSeqError(error) || attempt === this.maxRetries) {
          throw error;
        }
        lastError = error;
        const delay = computeBackoff(
          attempt,
          this.baseBackoffMs,
          this.maxBackoffMs,
        );
        await this.sleep(delay);
      }
    }
    // Unreachable, but satisfies the type checker.
    throw lastError ?? new Error('Sequence allocation failed');
  }
}

/**
 * In-memory allocator used when no Redis client is provided. Keeps existing
 * tests working without requiring a Redis instance.
 */
class InMemorySequenceNumberAllocator implements SequenceNumberAllocator {
  private readonly counters = new Map<string, number>();
  private readonly reservations = new Map<
    string,
    { account: string; sequence: number }
  >();
  private readonly baseBackoffMs: number;
  private readonly maxRetries: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SequenceNumberAllocatorOptions) {
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async reserve(account: string): Promise<SequenceReservation> {
    const next = (this.counters.get(account) ?? 0) + 1;
    this.counters.set(account, next);
    const reservationId = randomUUID();
    this.reservations.set(reservationId, { account, sequence: next });

    let settled = false;
    return {
      account,
      sequence: next,
      reservationId,
      rollback: async () => {
        if (settled) return;
        settled = true;
        await this.rollback(account, reservationId);
      },
      commit: async () => {
        if (settled) return;
        settled = true;
        this.reservations.delete(reservationId);
      },
    };
  }

  async rollback(account: string, reservationId: string): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.account !== account) return;
    this.reservations.delete(reservationId);
    const current = this.counters.get(account) ?? 0;
    if (current === reservation.sequence) {
      this.counters.set(account, current - 1);
    }
  }

  async withSequence<T>(
    account: string,
    fn: (sequence: number) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const reservation = await this.reserve(account);
      try {
        const result = await fn(reservation.sequence);
        await reservation.commit();
        return result;
      } catch (error) {
        await reservation.rollback().catch(() => undefined);
        if (!isTxBadSeqError(error) || attempt === this.maxRetries) {
          throw error;
        }
        lastError = error;
        const delay = computeBackoff(
          attempt,
          this.baseBackoffMs,
          this.maxBackoffMs,
        );
        await this.sleep(delay);
      }
    }
    throw lastError ?? new Error('Sequence allocation failed');
  }
}

/**
 * Factory that returns a Redis-backed allocator when a Redis client is
 * provided, otherwise falls back to an in-memory allocator.
 */
export function createSequenceNumberAllocator(
  options: SequenceNumberAllocatorOptions = {},
): SequenceNumberAllocator {
  if (options.redis) {
    return new RedisSequenceNumberAllocator({
      ...options,
      redis: options.redis,
    });
  }
  return new InMemorySequenceNumberAllocator(options);
}

export { isTxBadSeqError };