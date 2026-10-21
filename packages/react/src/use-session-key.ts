import { useCallback, useEffect, useState } from "react";
import { useLumen } from "./context.js";

export interface SessionKeyInfo {
  keypair: unknown;
  publicKey: string;
  secretKey: string;
  expiresAt: number;
}

export interface SessionKeyState {
  /** The active session's public key, or null if no session is active. */
  sessionKey: { publicKey: string; expiresAt: number } | null;
  /** Whether a session operation is in progress. */
  isLoading: boolean;
  /** Whether a session revocation is in progress. */
  isRevoking: boolean;
  /** Error from the last session operation, if any. */
  error: Error | null;
  /** True if the current session key has expired. */
  isExpired: boolean;
  /** Seconds remaining until the session expires (0 if expired or no session). */
  timeRemainingSeconds: number;
  /** Generate a new session keypair and register it with the client. */
  createSession: (durationSeconds?: number) => Promise<SessionKeyInfo>;
  /**
   * Revoke the currently active session key.
   *
   * When `submitOnChain` is true (the default), a `revoke_session_key`
   * transaction is submitted (and the server notified) before local state is
   * cleared. If on-chain revocation fails, the error is thrown and local state
   * is left intact so the session is not silently dropped.
   */
  revokeSession: (submitOnChain?: boolean) => Promise<void>;
}

/**
 * Manages the lifecycle of a session key for a given wallet.
 *
 * Session keys are temporary keypairs pre-authorized with a spend cap and time
 * limit, enabling gasless instant interactions without constant signature
 * prompts.
 *
 * @param walletId        - The wallet address to associate the session key with.
 * @param durationSeconds - Default session duration in seconds (default: 3600).
 */
export function useSessionKey(walletId: string, durationSeconds: number = 3600): SessionKeyState {
  const { client, isMounted } = useLumen();

  const [sessionKey, setSessionKey] = useState<{ publicKey: string; expiresAt: number } | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Tick every second to keep isExpired / timeRemainingSeconds up to date.
  useEffect(() => {
    if (!sessionKey) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sessionKey]);

  const isExpired = sessionKey !== null && now >= sessionKey.expiresAt;
  const timeRemainingSeconds =
    sessionKey && !isExpired ? Math.max(0, Math.floor((sessionKey.expiresAt - now) / 1000)) : 0;

  const createSession = useCallback(
    async (overrideDurationSeconds?: number): Promise<SessionKeyInfo> => {
      // SSR guard: keypair generation relies on window.crypto, which does not
      // exist on the server.
      if (typeof window === "undefined" || !isMounted) {
        const ssrError = new Error(
          "Session key creation requires a browser environment. " +
            "Wait for client-side hydration before calling createSession.",
        );
        setError(ssrError);
        throw ssrError;
      }

      setIsLoading(true);
      setError(null);
      try {
        const duration = overrideDurationSeconds ?? durationSeconds;
        const info = client.createSessionKey(duration);
        setSessionKey({ publicKey: info.publicKey, expiresAt: info.expiresAt });
        setNow(Date.now());
        return info;
      } catch (err) {
        const normalizedError = err instanceof Error ? err : new Error(String(err));
        setError(normalizedError);
        throw normalizedError;
      } finally {
        setIsLoading(false);
      }
    },
    [client, durationSeconds, isMounted],
  );

  const revokeSession = useCallback(
    async (submitOnChain: boolean = true): Promise<void> => {
      const current = sessionKey;
      if (!current) {
        setSessionKey(null);
        setError(null);
        return;
      }

      setIsRevoking(true);
      setError(null);
      try {
        if (submitOnChain) {
          // Submit a revoke_session_key transaction (and notify the server)
          // before clearing local state. A failure here must surface to the
          // caller rather than silently dropping the session.
          await client.revokeSessionKey(walletId, current.publicKey);
        }
        setSessionKey(null);
        setError(null);
      } catch (err) {
        const normalizedError = err instanceof Error ? err : new Error(String(err));
        setError(normalizedError);
        throw normalizedError;
      } finally {
        setIsRevoking(false);
      }
    },
    [client, sessionKey, walletId],
  );

  return {
    sessionKey,
    // Report a loading state until hydration completes on the client.
    isLoading: isLoading || !isMounted,
    isRevoking,
    error,
    isExpired,
    timeRemainingSeconds,
    createSession,
    revokeSession,
  };
}
