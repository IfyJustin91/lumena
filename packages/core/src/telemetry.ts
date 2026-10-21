/**
 * Pluggable SDK telemetry, diagnostics hook, and structured logger interface.
 *
 * This module allows SDK users to connect their own logging infrastructure
 * (Winston, Pino, Datadog, etc.) to Lumen SDK events by implementing the
 * {@link LumenLogger} interface and passing it to a {@link DiagnosticsHook}.
 *
 * All diagnostic events are emitted as structured payloads. Before any payload
 * reaches the user-provided logger it is passed through {@link redact}, which
 * strips sensitive fields (secret keys, private keys, seeds, mnemonics, auth
 * tokens, ...) from nested objects and arrays.
 */

/**
 * Structured logger interface that SDK users can implement to receive
 * diagnostic events from the Lumen SDK.
 *
 * Implementations should be safe to call from any context and must not throw.
 */
export interface LumenLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Transaction lifecycle stages that produce diagnostic events.
 */
export type TransactionLifecycleStage =
  | 'build'
  | 'sign'
  | 'submit'
  | 'confirm'
  | 'fail';

/**
 * Severity levels used when dispatching a diagnostic event to the logger.
 */
export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Base shape shared by all structured diagnostic events.
 */
export interface DiagnosticEventBase {
  /** Discriminator identifying the event type. */
  type: 'transaction';
  /** Lifecycle stage the event corresponds to. */
  stage: TransactionLifecycleStage;
  /** Severity the event should be logged at. */
  level: DiagnosticLevel;
  /** ISO-8601 timestamp of when the event was created. */
  timestamp: string;
  /** Optional correlation identifier (e.g. transaction id / hash). */
  correlationId?: string;
  /** Arbitrary additional structured metadata. */
  data?: Record<string, unknown>;
}

/**
 * Structured diagnostic event emitted for transaction lifecycle metrics.
 */
export interface TransactionDiagnosticEvent extends DiagnosticEventBase {
  type: 'transaction';
}

/**
 * Union of all structured diagnostic events emitted by the SDK.
 */
export type DiagnosticEvent = TransactionDiagnosticEvent;

/**
 * Options accepted by {@link DiagnosticsHook}.
 */
export interface DiagnosticsHookOptions {
  /** User-provided logger that receives structured diagnostic events. */
  logger: LumenLogger;
  /**
   * When `true` (default) payloads are passed through {@link redact} before
   * being handed to the logger.
   */
  redactSensitive?: boolean;
  /**
   * Optional clock used to timestamp events. Defaults to `Date.now`.
   * Primarily useful for deterministic tests.
   */
  now?: () => number;
}

/**
 * Field names (case-insensitive) that are considered sensitive and are
 * replaced with {@link REDACTED} before payloads reach the logger.
 */
export const SENSITIVE_FIELDS: readonly string[] = [
  'secretkey',
  'secret',
  'privatekey',
  'private',
  'seed',
  'mnemonic',
  'passphrase',
  'password',
  'authtoken',
  'auth_token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'apikey',
  'api_key',
  'bearer',
  'authorization',
  'signingkey',
  'signing_key',
  'keypair',
  'key_pair',
  'credential',
  'credentials',
];

/**
 * Placeholder value substituted for redacted fields.
 */
export const REDACTED = '[REDACTED]';

/**
 * Placeholder value substituted for Stellar secret keys detected by value.
 */
export const REDACTED_STELLAR_SECRET = '[REDACTED:stellar-secret]';

/**
 * Matches a Stellar secret key (StrKey encoding: `S` followed by 55 Base32
 * characters).
 */
const STELLAR_SECRET_PATTERN = /^S[A-Z2-7]{55}$/;

/**
 * Matches a Stellar secret key embedded anywhere inside a larger string.
 */
const STELLAR_SECRET_INLINE_PATTERN = /S[A-Z2-7]{55}/g;

/**
 * Matches a 12 or 24 word BIP39-style mnemonic phrase (lowercase words
 * separated by single spaces).
 */
const MNEMONIC_PATTERN = /^(?:[a-z]+ ){11}(?:[a-z]+)$|^(?:[a-z]+ ){23}(?:[a-z]+)$/;

const SENSITIVE_FIELD_SET = new Set(SENSITIVE_FIELDS.map((f) => f.toLowerCase()));

/**
 * Returns `true` if the given string is a Stellar secret key.
 */
export function isStellarSecretKey(value: string): boolean {
  return STELLAR_SECRET_PATTERN.test(value);
}

/**
 * Returns `true` if the given string looks like a 12/24 word mnemonic phrase.
 */
export function isMnemonicPhrase(value: string): boolean {
  return MNEMONIC_PATTERN.test(value);
}

/**
 * Redacts Stellar secret keys and mnemonic phrases from a string value.
 *
 * Strings that are entirely a secret key or mnemonic are replaced with
 * {@link REDACTED_STELLAR_SECRET}. Secret keys embedded inside larger strings
 * are replaced in place.
 */
export function redactString(value: string): string {
  if (isStellarSecretKey(value) || isMnemonicPhrase(value)) {
    return REDACTED_STELLAR_SECRET;
  }
  if (STELLAR_SECRET_INLINE_PATTERN.test(value)) {
    return value.replace(STELLAR_SECRET_INLINE_PATTERN, REDACTED_STELLAR_SECRET);
  }
  return value;
}

/**
 * Normalizes a field name for comparison against the sensitive field list.
 */
function normalizeFieldName(field: string): string {
  return field.toLowerCase().replace(/[-.\s]/g, '_');
}

/**
 * Returns `true` if the given field name is considered sensitive.
 */
export function isSensitiveField(field: string): boolean {
  const normalized = normalizeFieldName(field);
  if (SENSITIVE_FIELD_SET.has(normalized)) {
    return true;
  }
  // Also match the raw lowercased form (covers camelCase -> lowercase).
  return SENSITIVE_FIELD_SET.has(field.toLowerCase());
}

/**
 * Recursively redacts sensitive fields from a value.
 *
 * - Plain objects: sensitive keys are replaced with {@link REDACTED};
 *   remaining values are redacted recursively.
 * - Arrays: every element is redacted recursively.
 * - `Map`/`Set`: converted to plain arrays of redacted entries/values.
 * - `Date`: preserved as-is.
 * - Functions / symbols: replaced with `undefined` (not serializable).
 * - Strings: scanned for Stellar secret keys and mnemonic phrases, which are
 *   replaced with {@link REDACTED_STELLAR_SECRET}.
 * - Other primitives: returned unchanged.
 *
 * Circular references are handled by tracking visited objects.
 */
export function redact<T>(value: T, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (seen.has(value as object)) {
    return '[Circular]';
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  if (value instanceof Map) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      const key = String(k);
      result[key] = isSensitiveField(key) ? REDACTED : redact(v, seen);
    }
    return result;
  }

  if (value instanceof Set) {
    return Array.from(value.values()).map((item) => redact(item, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveField(key)) {
      result[key] = REDACTED;
    } else {
      result[key] = redact(val, seen);
    }
  }
  return result;
}

/**
 * Emits structured diagnostic events for transaction lifecycle metrics to a
 * user-provided {@link LumenLogger}.
 *
 * @example
 * ```ts
 * const hook = new DiagnosticsHook({ logger: myPinoLogger });
 * hook.transaction('build', { correlationId: 'tx-1', data: { fee: 100 } });
 * ```
 */
export class DiagnosticsHook {
  private readonly logger: LumenLogger;
  private readonly redactSensitive: boolean;
  private readonly now: () => number;

  constructor(options: DiagnosticsHookOptions) {
    if (!options || !options.logger) {
      throw new Error('DiagnosticsHook requires a logger');
    }
    this.logger = options.logger;
    this.redactSensitive = options.redactSensitive !== false;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Emits a structured diagnostic event for a transaction lifecycle stage.
   *
   * @param stage  Lifecycle stage (build, sign, submit, confirm, fail).
   * @param payload Optional correlation id and structured data.
   */
  public transaction(
    stage: TransactionLifecycleStage,
    payload: { correlationId?: string; data?: Record<string, unknown> } = {},
  ): TransactionDiagnosticEvent {
    const event: TransactionDiagnosticEvent = {
      type: 'transaction',
      stage,
      level: levelForStage(stage),
      timestamp: new Date(this.now()).toISOString(),
    };

    if (payload.correlationId !== undefined) {
      event.correlationId = payload.correlationId;
    }

    if (payload.data !== undefined) {
      event.data = (this.redactSensitive ? redact(payload.data) : payload.data) as Record<
        string,
        unknown
      >;
    }

    this.dispatch(event);
    return event;
  }

  /**
   * Emits an arbitrary structured diagnostic event.
   */
  public emit(event: DiagnosticEvent): DiagnosticEvent {
    const safeEvent = this.redactSensitive
      ? (redact(event) as DiagnosticEvent)
      : event;
    this.dispatch(safeEvent);
    return safeEvent;
  }

  private dispatch(event: DiagnosticEvent): void {
    const message = `transaction:${event.stage}`;
    const meta: Record<string, unknown> = { ...event };

    switch (event.level) {
      case 'debug':
        this.logger.debug(message, meta);
        break;
      case 'info':
        this.logger.info(message, meta);
        break;
      case 'warn':
        this.logger.warn(message, meta);
        break;
      case 'error':
        this.logger.error(message, meta);
        break;
      default:
        this.logger.info(message, meta);
        break;
    }
  }
}

/**
 * Maps a transaction lifecycle stage to a default log level.
 */
export function levelForStage(stage: TransactionLifecycleStage): DiagnosticLevel {
  switch (stage) {
    case 'build':
      return 'debug';
    case 'sign':
      return 'debug';
    case 'submit':
      return 'info';
    case 'confirm':
      return 'info';
    case 'fail':
      return 'error';
    default:
      return 'info';
  }
}

/**
 * Convenience factory for creating a {@link DiagnosticsHook}.
 */
export function createDiagnosticsHook(options: DiagnosticsHookOptions): DiagnosticsHook {
  return new DiagnosticsHook(options);
}