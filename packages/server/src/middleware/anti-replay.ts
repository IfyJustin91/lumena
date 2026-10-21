import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

export interface AntiReplayRedisClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface AntiReplayOptions {
  redis?: AntiReplayRedisClient;
  networkPassphrase: string;
  ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 10 * 60;
const RESERVE_REPLAY_KEYS_SCRIPT = `
for index = 1, #KEYS do
  if redis.call('EXISTS', KEYS[index]) == 1 then
    return 0
  end
end
for index = 1, #KEYS do
  redis.call('SET', KEYS[index], '1', 'EX', ARGV[1])
end
return 1
`;

export function createAntiReplayMiddleware(options: AntiReplayOptions): RequestHandler {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const processed = new Map<string, number>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const xdrs: unknown[] = Array.isArray(req.body?.transactions)
      ? req.body.transactions.map((transaction: { xdr?: unknown }) => transaction?.xdr)
      : [req.body?.xdr];
    const replayKeys = xdrs.flatMap((xdr) => {
      if (typeof xdr !== "string" || xdr.length === 0) return [];
      try {
        const parsed = TransactionBuilder.fromXDR(xdr, options.networkPassphrase);
        if (!(parsed instanceof Transaction)) return [];
        const key = createHash("sha256")
          .update(`${parsed.source}\n${parsed.sequence}\n${xdr}`)
          .digest("hex");
        return [`lumen:anti-replay:${key}`];
      } catch {
        return [];
      }
    });

    if (replayKeys.length === 0) {
      next();
      return;
    }

    const rejectReplay = (): void => {
      res.status(409).json({
        error: "Transaction envelope has already been submitted",
        code: "DUPLICATE_TRANSACTION_REPLAY",
      });
    };

    if (new Set(replayKeys).size !== replayKeys.length) {
      rejectReplay();
      return;
    }

    if (options.redis) {
      options.redis
        .eval(RESERVE_REPLAY_KEYS_SCRIPT, replayKeys.length, ...replayKeys, ttlSeconds)
        .then((result) => {
          if (result !== 1 && result !== "1") {
            rejectReplay();
            return;
          }
          next();
        })
        .catch(next);
      return;
    }

    const now = Date.now();
    for (const [key, expiresAt] of processed) {
      if (expiresAt <= now) processed.delete(key);
    }
    if (replayKeys.some((key) => processed.has(key))) {
      rejectReplay();
      return;
    }
    for (const key of replayKeys) processed.set(key, now + ttlSeconds * 1000);
    next();
  };
}
