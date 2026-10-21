import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors, { type CorsOptions } from "cors";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type RequestListener,
  type IncomingMessage,
} from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { Keypair, StrKey, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { StellarClient } from "@lumen/core";
import type { Signer } from "@lumen/types";
import type { WalletRegistry } from "@lumen/core";
import type { Redis } from "ioredis";
import { CosignerService } from "./cosigner/service.js";
import { FeeSponsorService } from "./fee-sponsor/service.js";
import { PolicyEngine } from "./policy/engine.js";
import { FailoverStellarClient, type StellarEndpoint } from "./stellar/router.js";
import { FraudDetector, type FraudDetectorConfig } from "./security/fraud-detector.js";
import {
  createTokenBucketLimiter,
  type TokenBucketConfig,
} from "./middleware/rate-limiter.js";
import { createIdempotencyMiddleware } from "./middleware/idempotency.js";
import { createAntiReplayMiddleware } from "./middleware/anti-replay.js";
import { createRbacMiddleware, type RbacConfig } from "./middleware/rbac.js";
import {
  createTenantAuthMiddleware,
  type TenantStore,
} from "./middleware/auth.js";
import { createSep10Router, type Sep10Config } from "./auth/sep10.js";
import type { SequenceAllocator } from "./fee-sponsor/sequence-allocator.js";
import {
  CosignRequestSchema,
  CosignBatchRequestSchema,
  FeeBumpRequestSchema,
  PolicyRequestSchema,
  WebhookRequestSchema,
  WebhookPatchSchema,
} from "./validation.js";
import swaggerUi from "swagger-ui-express";
import { openApiSpec } from "./openapi.js";
import { ValidationError, PolicyError, errorHandler, wrapHandler } from "./errors.js";
import { logger, httpLogger } from "./logger.js";
import {
  register,
  cosignRequestsTotal,
  feeBumpRequestsTotal,
  policyEvaluationDurationSeconds,
} from "./metrics.js";

import { SponsorMonitorService } from "./fee-sponsor/monitor.js";
import { SponsorRefillService } from "./fee-sponsor/refill.js";
import { LedgerIngestionWorker, type LedgerTransactionUpdate } from "./ledger/ingest.js";
import { WebhookDispatcher } from "./webhook/dispatcher.js";
import { createGraphQLGateway } from "./graphql/index.js";
import { createWalletWebSocketServer } from "./websocket/index.js";
import { MerkleAuditLog, parseAuditRecord } from "./audit/merkle-log.js";

/** A single policy decision broadcast on the audit stream. */
export interface AuditEvent {
  /** ISO timestamp of when the decision was made. */
  timestamp: string;
  /** Whether the transaction was approved or rejected by policy. */
  decision: "approved" | "rejected";
  /** Wallet address the decision applies to, when known. */
  wallet?: string;
  /** Transaction hash, when known. */
  txHash?: string;
  /** Fee (in stroops) associated with the transaction, when known. */
  fee?: string;
  /** Human-readable reason for the decision (typically on rejections). */
  reason?: string;
}

export interface ServerResult {
  /** Configured Express application. */
  app: Express;
  /** Node HTTP server wrapping the Express application. */
  server: HttpServer;
  /** Stellar/Horizon/RPC client used by server services. */
  client: StellarClient;
  /** Latency-aware failover router, when multiple endpoints are configured. */
  stellarRouter?: FailoverStellarClient;
  /** Real-time anomaly/fraud detector used by the co-signer service. */
  fraudDetector: FraudDetector;
  cosignerService: CosignerService;
  feeSponsorService: FeeSponsorService;
  sponsorMonitorService: SponsorMonitorService;
  ledgerIngestionWorker?: LedgerIngestionWorker;
  policyEngine: PolicyEngine;
  webhookDispatcher: WebhookDispatcher;
  /** WebSocket server backing the real-time audit stream. */
  auditWebSocketServer: WebSocketServer;
  /** Wallet event WebSocket backing the real-time wallet subscription stream. */
  walletWebSocketServer: WebSocketServer;
  /** Broadcasts a policy decision to all connected audit stream clients. */
  broadcastAuditEvent: (event: AuditEvent) => void;
  /** Broadcasts a wallet-scoped event to all subscribers for that wallet. */
  broadcastWalletEvent: (walletAddress: string, event: string, payload?: Record<string, unknown>) => void;
  /** Hash-chained audit decisions and Merkle-root verification. */
  auditLog: MerkleAuditLog;
  /**
   * Stops accepting new connections and drains in-flight requests.
   * Resolves once the HTTP server has closed (or the grace period elapses).
   */
  shutdown: (gracePeriodMs?: number) => Promise<void>;
}

export interface ServerOpts {
  /** Port used by the HTTP server. Defaults to 3000. */
  port?: number;
  /** Stellar network preset used for Horizon/RPC defaults. */
  network?: "testnet" | "mainnet" | "local";
  horizonUrl?: string;
  rpcUrl?: string;
  /**
   * Pool of Horizon and Soroban RPC endpoints used by the latency-aware
   * failover router. When more than one endpoint is provided, a
   * FailoverStellarClient is instantiated and used for routing.
   */
  stellarEndpoints?: StellarEndpoint[];
  /**
   * Interval (ms) between background health/latency pings of the router.
   */
  stellarHealthCheckIntervalMs?: number;
  /**
   * Optional fraud detector configuration (velocity/geo-IP thresholds).
   */
  fraudDetectorConfig?: FraudDetectorConfig;
  /**
   * Optional pre-built fraud detector instance.
   */
  fraudDetector?: FraudDetector;
  /**
   * Signer used by the co-signer service.
   * Dev/testnet → EnvSigner.  Production → AwsKmsSigner or equivalent.
   */
  cosignerSigner: Signer;
  /**
   * Signer used by the fee-sponsor service.
   * Dev/testnet → EnvSigner.  Production → AwsKmsSigner or equivalent.
   */
  feePayerSigner: Signer;
  minSponsorBalance?: number;
  sponsorPollIntervalMs?: number;
  /** Transfer XLM from a configured treasury when the sponsor balance is low. */
  sponsorRefillTransfer?: (amountXlm: number) => Promise<void>;
  sponsorTargetBalanceXlm?: number;
  sponsorRefillCooldownMs?: number;
  /** Persist finalized Horizon transaction status and actual charged fee. */
  updateLedgerTransaction?: (update: LedgerTransactionUpdate) => Promise<void>;
  webhookDispatcher?: WebhookDispatcher;
  /**
   * Optional CORS configuration passed to the `cors` npm package.
   * Cross-origin access is disabled by default.
   */
  cors?: CorsOptions;
  /** Loads the current allowlist of CORS origins; refreshed every 60 seconds. */
  corsOriginProvider?: () => Promise<string[]>;
  /**
   * Optional PolicyEngine instance.
   */
  policyEngine?: PolicyEngine;
  /**
   * Optional API key to protect server endpoints.
   * When set, requires 'Authorization: Bearer <api-key>' on all routes except /health and /metrics.
   */
  apiKey?: string;
  /**
   * Rate limiting window in milliseconds for /cosign and /fee-bump endpoints.
   */
  windowMs?: number;
  /**
   * Maximum requests allowed within windowMs for /cosign and /fee-bump endpoints.
   */
  max?: number;
  /**
   * Rate limit options for /cosign and /fee-bump endpoints.
   */
  rateLimit?: {
    windowMs?: number;
    max?: number;
  };
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
  /**
   * Optional WalletRegistry to persist and list registered wallet addresses.
   * When provided, POST /wallet/create registers the new wallet and
   * GET /wallets lists all registered wallets.
   */
  walletRegistry?: WalletRegistry;
  /**
   * Optional readiness probe for downstream dependencies (Redis, PostgreSQL, ...).
   * Used by the /health endpoint so container healthchecks can verify the
   * server is healthy within 30 seconds.
   */
  readinessCheck?: () => Promise<Record<string, boolean>>;
  /**
   * Optional Redis client used by the token bucket rate limiter and the
   * idempotency middleware. When omitted, an in-memory fallback is used.
   */
  redis?: Redis;
  /** Optional publisher for hourly Merkle roots; Redis stores roots by default when configured. */
  publishAuditRoot?: (root: string, timestamp: string) => Promise<void>;
  /**
   * Token bucket configuration for per-client-IP rate limiting.
   * `capacity` is the maximum burst size; `refillRate` is the steady-state
   * number of tokens replenished per second.
   */
  ipRateLimit?: TokenBucketConfig;
  /**
   * Token bucket configuration for per-wallet-address rate limiting.
   */
  walletRateLimit?: TokenBucketConfig;
  /**
   * Optional RBAC configuration (JWT secret / role claim) for admin routes.
   */
  rbac?: RbacConfig;
  /**
   * Optional multi-tenant API key store. When provided, requests are
   * authenticated against tenant API keys and subject to per-tenant quotas.
   */
  tenantStore?: TenantStore;
  /**
   * Optional distributed sequence number allocator (Redis Redlock) shared by
   * the fee-sponsor and co-signer services.
   */
  sequenceAllocator?: SequenceAllocator;
  /**
   * Optional SEP-10 web authentication configuration. When provided, the
   * `/auth` router (challenge + token) is mounted.
   */
  sep10?: Sep10Config;
  /**
   * Grace period (ms) used by the shutdown hook to drain in-flight requests.
   * Defaults to 15000.
   */
  shutdownGracePeriodMs?: number;
}

function getTransactionHash(xdr: string, networkPassphrase: string): string {
  const envelopeHash = createHash("sha256").update(xdr).digest("hex");
  try {
    const transaction = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    return transaction instanceof Transaction ? transaction.hash().toString("hex") : envelopeHash;
  } catch {
    return envelopeHash;
  }
}

function getPackageVersion(): string {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const candidatePaths = [
      path.resolve(currentDir, "../package.json"),
      path.resolve(currentDir, "../../package.json"),
      path.resolve(process.cwd(), "package.json"),
      path.resolve(process.cwd(), "packages/server/package.json"),
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(p, "utf-8")) as { name?: string; version?: string };
          if (pkg.name === "@lumen/server" && typeof pkg.version === "string") {
            return pkg.version;
          }
        } catch {
          // ignore parsing error and continue
        }
      }
    }
  } catch {
    // fallback
  }
  return process.env.npm_package_version || "0.1.0";
}

/** Creates the Lumen API server, service graph, and policy engine. */
export function createServer(opts: ServerOpts): ServerResult {
  const port = opts.port ?? 3000;

  const client = new StellarClient({
    network: opts.network,
    horizonUrl: opts.horizonUrl,
    rpcUrl: opts.rpcUrl,
  });

  // #240 — latency-aware failover router across multiple Horizon/RPC endpoints.
  let stellarRouter: FailoverStellarClient | undefined;
  if (opts.stellarEndpoints && opts.stellarEndpoints.length > 1) {
    stellarRouter = new FailoverStellarClient({
      endpoints: opts.stellarEndpoints,
      healthCheckIntervalMs: opts.stellarHealthCheckIntervalMs,
    });
    stellarRouter.start();
  }

  // #241 — real-time anomaly/fraud detection.
  const fraudDetector =
    opts.fraudDetector ?? new FraudDetector(opts.fraudDetectorConfig ?? {});

  const policyEngine = opts.policyEngine ?? new PolicyEngine();
  const webhookDispatcher = opts.webhookDispatcher ?? new WebhookDispatcher();

  const cosignerService = new CosignerService({
    client,
    signer: opts.cosignerSigner,
    policyEngine,
    webhookDispatcher,
    fraudDetector,
    sequenceAllocator: opts.sequenceAllocator,
  });

  const feeSponsorService = new FeeSponsorService({
    client,
    signer: opts.feePayerSigner,
    webhookDispatcher,
    sequenceAllocator: opts.sequenceAllocator,
  });

  const sponsorRefillService = opts.sponsorRefillTransfer
    ? new SponsorRefillService({
        transfer: opts.sponsorRefillTransfer,
        targetBalanceXlm: opts.sponsorTargetBalanceXlm ?? opts.minSponsorBalance ?? 50,
        cooldownMs: opts.sponsorRefillCooldownMs,
      })
    : undefined;

  const sponsorMonitorService = new SponsorMonitorService({
    client,
    sponsorPublicKey: opts.feePayerSigner.publicKey(),
    minBalanceXlm: opts.minSponsorBalance,
    pollIntervalMs: opts.sponsorPollIntervalMs,
    webhookDispatcher,
    onLowBalance: sponsorRefillService
      ? async (balance, threshold) => {
          await sponsorRefillService.refillIfLow(balance, threshold);
        }
      : undefined,
  });

  const app = express();
  app.use((req, res, next) => {
    httpLogger(req as unknown as IncomingMessage, res, next);
  });
  app.use(express.json());

  const redis = opts.redis;
  const appendAuditRecordScript = `
local previous = redis.call('LINDEX', KEYS[1], -1)
if previous then
  if cjson.decode(previous)['hash'] ~= ARGV[1] then return 0 end
elseif ARGV[1] ~= '' then
  return 0
end
redis.call('RPUSH', KEYS[1], ARGV[2])
return 1
`;
  const auditLog = new MerkleAuditLog(
    redis
      ? {
          load: async () =>
            (await redis.lrange("lumen:audit:records", 0, -1)).map(parseAuditRecord),
          append: async (record) => {
            const result = await redis.eval(
              appendAuditRecordScript,
              1,
              "lumen:audit:records",
              record.prevHash,
              JSON.stringify(record),
            );
            return result === 1;
          },
        }
      : undefined,
  );
  void auditLog.ready().catch((error: unknown) => {
    logger.error({ error }, "Failed to load or verify stored audit log");
  });
  const corsOriginProvider =
    opts.corsOriginProvider ?? (redis ? () => redis.smembers("lumen:cors:origins") : undefined);
  let corsOriginCache: { origins: string[]; expiresAt: number } | undefined;
  const corsOptions: CorsOptions = corsOriginProvider
    ? {
        ...opts.cors,
        origin: (origin, callback) => {
          if (!origin) {
            callback(null, true);
            return;
          }

          const resolveOrigins = async (): Promise<string[]> => {
            if (!corsOriginCache || corsOriginCache.expiresAt <= Date.now()) {
              const origins = await corsOriginProvider();
              corsOriginCache = { origins, expiresAt: Date.now() + 60_000 };
            }
            return corsOriginCache.origins;
          };

          void resolveOrigins()
            .then((origins) => {
              const requestOrigin = new URL(origin).origin.toLowerCase();
              const hostname = new URL(origin).hostname.toLowerCase();
              const allowed = origins.some((entry) => {
                const normalized = entry.trim().toLowerCase();
                if (normalized.startsWith("*.")) {
                  const suffix = normalized.slice(1);
                  return hostname.endsWith(suffix) && hostname !== suffix.slice(1);
                }
                try {
                  return normalized.includes("://")
                    ? new URL(normalized).origin === requestOrigin
                    : hostname === normalized;
                } catch {
                  return false;
                }
              });
              callback(allowed ? null : new Error("Origin is not allowed by CORS"), allowed);
            })
            .catch((error: unknown) =>
              callback(error instanceof Error ? error : new Error(String(error))),
            );
        },
      }
    : (opts.cors ?? { origin: false });
  app.use(cors(corsOptions));

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.id) {
      res.setHeader("x-request-id", req.id as string);
    }
    next();
  });

  // Multi-tenant API key authentication + tiered quota enforcement.
  // Falls back to the legacy single global API key when no tenant store is
  // configured. /health and /metrics remain public.
  const tenantAuth = createTenantAuthMiddleware({
    tenantStore: opts.tenantStore,
    legacyApiKey: opts.apiKey,
    redis: opts.redis,
  });
  app.use(tenantAuth);

  // Token bucket rate limiting (sliding-window, burst + steady-state refill).
  // Backward-compatible options map windowMs/max onto bucket capacity/refill.
  const legacyWindowMs =
    opts.rateLimit?.windowMs ?? opts.rateLimitWindowMs ?? opts.windowMs ?? 60 * 1000;
  const legacyMax = opts.rateLimit?.max ?? opts.rateLimitMax ?? opts.max ?? 100;

  const ipRateLimit: TokenBucketConfig = opts.ipRateLimit ?? {
    capacity: legacyMax,
    refillRate: legacyMax / (legacyWindowMs / 1000),
  };
  const walletRateLimit: TokenBucketConfig = opts.walletRateLimit ?? {
    capacity: legacyMax,
    refillRate: legacyMax / (legacyWindowMs / 1000),
  };

  const rateLimiter = createTokenBucketLimiter({
    redis: opts.redis,
    ip: ipRateLimit,
    wallet: walletRateLimit,
  });

  const idempotency = createIdempotencyMiddleware({ redis: opts.redis });
  const antiReplay = createAntiReplayMiddleware({
    redis: opts.redis,
    networkPassphrase: client.networkPassphrase,
  });
  const rbac = createRbacMiddleware(opts.rbac);

  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));

  // #235 — SEP-10 web authentication (challenge + token issuance).
  if (opts.sep10) {
    app.use(
      "/auth",
      createSep10Router({
        ...opts.sep10,
        client,
        signer: opts.sep10.signer ?? opts.cosignerSigner,
      }),
    );
  }

  let activeRequests = 0;

  app.use((_req: Request, _res: Response, next: NextFunction) => {
    activeRequests++;
    _res.on("finish", () => {
      activeRequests--;
    });
    next();
  });

  app.get(
    "/health",
    wrapHandler(async (_req, res) => {
      let horizonConnected = false;
      try {
        await client.horizon.root();
        horizonConnected = true;
      } catch {
        horizonConnected = false;
      }

      let dependencies: Record<string, boolean> = {};
      if (opts.readinessCheck) {
        try {
          dependencies = await opts.readinessCheck();
        } catch (error) {
          logger.error({ error }, "Readiness check failed");
          dependencies = { readiness: false };
        }
      }

      const dependenciesHealthy = Object.values(dependencies).every(Boolean);
      const healthy = horizonConnected && dependenciesHealthy;

      res.status(healthy ? 200 : 503).json({
        status: healthy ? "ok" : "degraded",
        horizonConnected,
        dependencies,
        network: client.config.network,
        version: getPackageVersion(),
      });
    }),
  );

  app.get(
    "/health/deep",
    wrapHandler(async (_req: Request, res: Response) => {
      const report = await runDeepHealthCheck({
        client,
        cosignerSigner: opts.cosignerSigner,
        feeSponsorService,
        sponsorMonitorService,
        readinessCheck: opts.readinessCheck,
        minSponsorBalance: opts.minSponsorBalance,
      });
      res.status(report.healthy ? 200 : 503).json(report);
    }),
  );

  app.get(
    "/metrics",
    wrapHandler(async (_req: Request, res: Response) => {
      res.setHeader("Content-Type", register.contentType);
      res.send(await register.metrics());
    }),
  );

  app.get(
    "/sponsor/status",
    wrapHandler(async (_req: Request, res: Response) => {
      const status = await sponsorMonitorService.checkBalance();
      res.json(status);
    }),
  );

  app.post(
    "/cosign",
    rateLimiter,
    antiReplay,
    idempotency,
    wrapHandler(async (req: Request, res: Response) => {
      const timer = policyEvaluationDurationSeconds.startTimer();
      try {
        const parsed = CosignRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          cosignRequestsTotal.inc({ status: "rejected" });
          throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
        }

        const result = await cosignerService.cosign(parsed.data);
        const transactionHash = getTransactionHash(parsed.data.xdr, client.networkPassphrase);
        await auditLog.append({
          txHash: transactionHash,
          walletAddress: parsed.data.walletAddress,
          decision: result.approved ? "approved" : "rejected",
          rulesEvaluated: result.rulesEvaluated ?? [],
        });

        if (!result.approved) {
          cosignRequestsTotal.inc({ status: "rejected" });
          const transaction = TransactionBuilder.fromXDR(parsed.data.xdr, client.networkPassphrase);
          const txHash = transaction.hash().toString("hex");
          broadcastAuditEvent({
            timestamp: new Date().toISOString(),
            decision: "rejected",
            wallet: parsed.data.walletAddress,
            txHash,
            reason: result.reason ?? "Transaction denied by policy",
          });
          broadcastWalletEvent(parsed.data.walletAddress, "policy_violated", {
            txHash,
            reason: result.reason ?? "Transaction denied by policy",
          });
          throw new PolicyError(result.reason ?? "Transaction denied by policy");
        }

        cosignRequestsTotal.inc({ status: "approved" });
        const transaction = TransactionBuilder.fromXDR(parsed.data.xdr, client.networkPassphrase);
        const txHash = transaction.hash().toString("hex");
        broadcastAuditEvent({
          timestamp: new Date().toISOString(),
          decision: "approved",
          wallet: parsed.data.walletAddress,
          txHash,
        });
        broadcastWalletEvent(parsed.data.walletAddress, "cosigned", {
          txHash,
        });
        res.json({ signedXdr: result.signedXdr });
      } catch (err) {
        if (!(err instanceof ValidationError) && !(err instanceof PolicyError)) {
          cosignRequestsTotal.inc({ status: "rejected" });
        }
        throw err;
      } finally {
        timer();
      }
    }),
  );

  // #243 — batch co-signing with atomic policy evaluation.
  app.post(
    "/cosign/batch",
    cosignFeeBumpLimiter,
    antiReplay,
    wrapHandler(async (req: Request, res: Response) => {
      const parsed = CosignBatchRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
      }

      const results = await cosignerService.cosignBatch(parsed.data.transactions);
      await Promise.all(
        parsed.data.transactions.map((transaction, index) =>
          auditLog.append({
            txHash: getTransactionHash(transaction.xdr, client.networkPassphrase),
            walletAddress: transaction.walletAddress,
            decision: results[index]?.approved ? "approved" : "rejected",
            rulesEvaluated: results[index]?.rulesEvaluated ?? [],
          }),
        ),
      );

      const allApproved = results.every((r) => r.approved);
      if (allApproved) {
        cosignRequestsTotal.inc({ status: "approved" }, results.length);
      } else {
        const approvedCount = results.filter((r) => r.approved).length;
        if (approvedCount > 0) {
          cosignRequestsTotal.inc({ status: "approved" }, approvedCount);
        }
        cosignRequestsTotal.inc({ status: "rejected" }, results.length - approvedCount);
      }

      const responseResults = results.map(({ rulesEvaluated: _rulesEvaluated, ...result }) => result);
      res.status(allApproved ? 200 : 207).json({ results: responseResults });
    }),
  );

  app.post(
    "/fee-bump",
    rateLimiter,
    idempotency,
    wrapHandler(async (req: Request, res: Response) => {
      feeBumpRequestsTotal.inc();
      const parsed = FeeBumpRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
      }

      const feeBumpXdr = await feeSponsorService.wrapFeeBump(parsed.data.xdr);
      res.json({ feeBumpXdr });
    }),
  );

  app.post(
    "/fee-bump/submit",
    rateLimiter,
    idempotency,
    wrapHandler(async (req: Request, res: Response) => {
      feeBumpRequestsTotal.inc();
      const parsed = FeeBumpRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
      }

      const result = await feeSponsorService.submit(parsed.data.xdr);
      const submittedTransaction = TransactionBuilder.fromXDR(
        parsed.data.xdr,
        client.networkPassphrase,
      );
      if (submittedTransaction instanceof Transaction) {
        broadcastWalletEvent(submittedTransaction.source, "submitted", { hash: result.hash });
      }
      res.json(result);
    }),
  );

  app.get("/policy/:walletId", (req: Request, res: Response) => {
    const policy = policyEngine.getPolicy(req.params.walletId as string);
    if (!policy) {
      throw new PolicyError("No policy found", 404);
    }
    res.setHeader("ETag", `"${policy.version}"`);
    res.json(policy);
  });

  app.post(
    "/policy",
    rbac.requirePermission("policy:write"),
    idempotency,
    wrapHandler(async (req: Request, res: Response) => {
      const parsed = PolicyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
      }

      if (policyEngine.getPolicy(parsed.data.walletId)) {
        throw new PolicyError("A policy already exists for this wallet", 409);
      }

      const policy = {
        id: crypto.randomUUID(),
        walletId: parsed.data.walletId,
        rules: parsed.data.rules,
        createdAt: new Date(),
        version: 1,
      };

      policyEngine.addPolicy(policy);
      res.status(201).json(policy);
    }),
  );

  app.put(
    "/policy/:walletId",
    rbac.requirePermission("policy:write"),
    idempotency,
    wrapHandler(async (req: Request, res: Response) => {
      const parsed = PolicyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
      }

      const walletId = req.params.walletId as string;
      if (parsed.data.walletId !== walletId) {
        throw new ValidationError("walletId in the request body must match the URL");
      }

      const existingPolicy = policyEngine.getPolicy(walletId);
      if (!existingPolicy) {
        throw new PolicyError("No policy found", 404);
      }

      // #366 — optimistic concurrency control via If-Match / ETag.
      const ifMatch = req.headers["if-match"];
      const ifMatchValue = Array.isArray(ifMatch) ? ifMatch[0] : ifMatch;
      if (ifMatchValue === undefined || ifMatchValue.trim() === "") {
        throw new PolicyError(
          "If-Match header is required to update a policy",
          412,
        );
      }

      const normalized = ifMatchValue.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
      const expectedVersion = Number(normalized);
      if (!Number.isInteger(expectedVersion) || expectedVersion !== existingPolicy.version) {
        throw new PolicyError(
          `Policy version mismatch: expected version ${existingPolicy.version}`,
          412,
        );
      }

      const policy = {
        ...existingPolicy,
        rules: parsed.data.rules,
        version: existingPolicy.version + 1,
      };

      policyEngine.addPolicy(policy);
      res.setHeader("ETag", `"${policy.version}"`);
      res.json(policy);
    }),
  );

  app.delete("/policy/:walletId", rbac.requirePermission("policy:write"), (req: Request, res: Response) => {
    const walletId = req.params.walletId as string;
    if (!policyEngine.getPolicy(walletId)) {
      throw new PolicyError("No policy found", 404);
    }

    policyEngine.removePolicy(walletId);
    res.status(204).send();
  });

  app.post(
    "/wallet/create",
    idempotency,
    wrapHandler(async (req: Request, res: Response) => {
      const { Wallet } = await import("@lumen/core");

      const sponsorKeypair = Keypair.fromPublicKey(opts.cosignerSigner.publicKey());
      const wallet = new Wallet({
        client,
        sponsorKeypair,
        serverPublicKey: opts.cosignerSigner.publicKey(),
      });

      const result = await wallet.create();

      // Register the new wallet address if a registry is configured
      if (opts.walletRegistry) {
        await opts.walletRegistry.register(result.address);
      }

      void webhookDispatcher
        .dispatch("wallet.created", {
          address: result.address,
          publicKey: result.publicKey,
        })
        .catch((error: unknown) => {
          logger.error({ error }, "Failed to dispatch wallet.created webhook");
        });
      res.json({ address: result.address, publicKey: result.publicKey });
    }),
  );

  // #169 — GET /wallets: list all registered wallets
  app.get(
    "/wallets",
    rbac.requirePermission("wallets:read"),
    wrapHandler(async (req: Request, res: Response) => {
      if (!opts.walletRegistry) {
        res.json({ wallets: [], total: 0 });
        return;
      }

      const allWallets = await opts.walletRegistry.list();

      const limitParam = req.query.limit;
      const offsetParam = req.query.offset;

      const limit = limitParam === undefined ? 50 : Math.max(1, Math.min(200, Number(limitParam)));
      const offset = offsetParam === undefined ? 0 : Math.max(0, Number(offsetParam));

      const paginated = allWallets.slice(offset, offset + limit);

      res.json({ wallets: paginated, total: allWallets.length });
    }),
  );

  // #170 — GET /policy: list all configured policies
  app.get(
    "/policy",
    wrapHandler(async (_req: Request, res: Response) => {
      const policies = policyEngine.listPolicies();
      res.json({ policies, count: policies.length });
    }),
  );

  app.get(
    "/wallet/:address/transactions",
    wrapHandler(async (req: Request, res: Response) => {
      const address = req.params.address as string;
      if (!StrKey.isValidEd25519PublicKey(address)) {
        throw new ValidationError("address must be a valid Stellar public key");
      }

      const limitParam = req.query.limit;
      const limit = limitParam === undefined ? 20 : Number(limitParam);
      if (
        (limitParam !== undefined && typeof limitParam !== "string") ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200
      ) {
        throw new ValidationError("limit must be an integer between 1 and 200");
      }

      const cursorParam = req.query.cursor;
      if (cursorParam !== undefined && typeof cursorParam !== "string") {
        throw new ValidationError("cursor must be a string");
      }

      let transactions = client.horizon
        .transactions()
        .forAccount(address)
        .order("desc")
        .limit(limit);
      if (cursorParam) {
        transactions = transactions.cursor(cursorParam);
      }
      const page = await transactions.call();
      const records = page.records;
      res.json({
        address,
        transactions: records,
        nextCursor: records.at(-1)?.paging_token ?? null,
      });
    }),
  );

  app.get(
    "/wallet/:address/balance",
    wrapHandler(async (req: Request, res: Response) => {
      const address = req.params.address as string;
      if (!StrKey.isValidEd25519PublicKey(address)) {
        throw new ValidationError("address must be a valid Stellar public key");
      }

      const account = await client.horizon.loadAccount(address);
      res.json({ address, balances: account.balances });
    }),
  );

  app.post(
    "/webhooks",
    rbac.requirePermission("webhooks:write"),
    idempotency,
    wrapHandler(async (req: Request, res: Response) => {
      const parsed = WebhookRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
      }
      const { id: bodyId, url, secret, events, enabled } = parsed.data;
      const id = bodyId ?? crypto.randomUUID();
      webhookDispatcher.register({ id, url, secret, events, enabled: enabled ?? true });
      res.status(201).json({ id, url, events, enabled: enabled ?? true });
    }),
  );

  app.get("/webhooks", (_req: Request, res: Response) => {
    res.json(webhookDispatcher.list().map(({ secret: _secret, ...rest }) => rest));
  });

  app.delete("/webhooks/:id", rbac.requirePermission("webhooks:write"), (req: Request, res: Response) => {
    const deleted = webhookDispatcher.unregister(req.params.id as string);
    if (!deleted) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    res.status(204).send();
  });

  app.patch(
    "/webhooks/:id",
    rbac.requirePermission("webhooks:write"),
    idempotency,
    wrapHandler(async (req: Request, res: Response) => {
      const id = req.params.id as string;

      const parsed = WebhookPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
      }

      const updated = webhookDispatcher.update(id, parsed.data);
      if (!updated) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }

      const { secret: _secret, ...safeConfig } = updated;
      res.json(safeConfig);
    }),
  );

  app.post(
    "/webhooks/:id/test",
    rbac.requirePermission("webhooks:write"),
    idempotency,
    wrapHandler(async (req: Request, res: Response) => {
      const id = req.params.id as string;

      if (!webhookDispatcher.get(id)) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }

      const result = await webhookDispatcher.sendTest(id);
      res.json({
        success: result.success,
        statusCode: result.statusCode ?? null,
        attempts: result.attempts,
        responseTimeMs: result.responseTimeMs,
      });
    }),
  );

  app.get(
    "/webhooks/deliveries",
    wrapHandler(async (req: Request, res: Response) => {
      const fullLog = await webhookDispatcher.getDeliveryLog();
      const limitParam = req.query.limit;
      const offsetParam = req.query.offset;

      if (limitParam === undefined && offsetParam === undefined) {
        res.json(fullLog);
        return;
      }

      const limit = limitParam === undefined ? 50 : Math.max(1, Math.min(200, Number(limitParam)));
      const offset = offsetParam === undefined ? 0 : Math.max(0, Number(offsetParam));
      const paginated = fullLog.slice(offset, offset + limit);

      res.json(paginated);
    }),
  );

  // #236 — per-webhook delivery history and manual retry of DLQ entries.
  app.get(
    "/webhooks/:id/deliveries",
    wrapHandler(async (req: Request, res: Response) => {
      const id = req.params.id as string;
      if (!webhookDispatcher.get(id)) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }
      res.json(await webhookDispatcher.getDeliveries(id));
    }),
  );

  app.post(
    "/webhooks/deliveries/:id/retry",
    rbac.requirePermission("webhooks:write"),
    idempotency,
    wrapHandler(async (req: Request, res: Response) => {
      const deliveryId = req.params.id as string;
      const result = await webhookDispatcher.retryDelivery(deliveryId);
      if (!result) {
        res.status(404).json({ error: "Delivery not found" });
        return;
      }
      res.json(result);
    }),
  );

  // GraphQL gateway (queries + SSE subscriptions) served alongside the REST endpoints.
  const graphqlGateway = createGraphQLGateway({ client, policyEngine });
  app.use(graphqlGateway.graphqlEndpoint, graphqlGateway);

  app.use(errorHandler);

  const server = createHttpServer(app as unknown as RequestListener);

  // Real-time audit stream consumed by `lumen audit --follow`.
  const auditWebSocketServer = new WebSocketServer({ noServer: true });
  const auditClients = new Set<WebSocket>();
  const walletWebSocketServer = createWalletWebSocketServer();

  const broadcastAuditEvent = (event: AuditEvent): void => {
    const payload = JSON.stringify(event);
    for (const socket of auditClients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  };

  const broadcastWalletEvent = (
    walletAddress: string,
    event: string,
    payload: Record<string, unknown> = {},
  ): void => {
    walletWebSocketServer.broadcast(walletAddress, event, payload);
  };

  const ledgerIngestionWorker = opts.walletRegistry && opts.updateLedgerTransaction
    ? new LedgerIngestionWorker({
        client,
        listWalletAddresses: async () => opts.walletRegistry!.list(),
        updateTransaction: opts.updateLedgerTransaction,
        onUpdate: (update) => {
          broadcastWalletEvent(update.walletAddress, "confirmed", {
            hash: update.hash,
            status: update.status,
            fee: update.fee,
            ledger: update.ledger,
          });
        },
      })
    : undefined;
  const publishAuditRoot = async (): Promise<void> => {
    await auditLog.ready();
    const root = auditLog.merkleRoot();
    if (!root) return;
    const timestamp = new Date().toISOString();
    if (opts.publishAuditRoot) {
      await opts.publishAuditRoot(root, timestamp);
    } else if (opts.redis) {
      await opts.redis.set(
        `lumen:audit:merkle:${timestamp.slice(0, 13)}`,
        root,
        "EX",
        365 * 24 * 60 * 60,
      );
    }
  };
  const auditRootInterval =
    opts.publishAuditRoot || opts.redis
      ? setInterval(() => {
          publishAuditRoot().catch((error: unknown) => {
            logger.error({ error }, "Failed to publish audit Merkle root");
          });
        }, 60 * 60 * 1000)
      : null;
  auditRootInterval?.unref();

  auditWebSocketServer.on("connection", (socket: WebSocket) => {
    auditClients.add(socket);
    socket.on("close", () => {
      auditClients.delete(socket);
    });
    socket.on("error", () => {
      auditClients.delete(socket);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const pathname = (req.url ?? "").split("?")[0];
    if (pathname === "/audit/stream") {
      auditWebSocketServer.handleUpgrade(req, socket, head, (ws) => {
        auditWebSocketServer.emit("connection", ws, req);
      });
      return;
    }

    if (pathname === "/ws") {
      walletWebSocketServer.server.handleUpgrade(req, socket, head, (ws) => {
        walletWebSocketServer.server.emit("connection", ws, req);
      });
      return;
    }

    socket.destroy();
  });

  sponsorMonitorService.start();
  ledgerIngestionWorker?.start();

  server.listen(port, () => {
    logger.info({ port, network: client.config.network }, `Lumen server listening on port ${port}`);
    logger.info(
      { cosigner: opts.cosignerSigner.publicKey(), feePayer: opts.feePayerSigner.publicKey() },
      "Signer addresses initialized",
    );
  });

  /**
   * Stops accepting new connections and drains in-flight requests within the
   * grace period. Used by the lifecycle handler (SIGINT/SIGTERM).
   */
  const shutdown = (gracePeriodMs: number = opts.shutdownGracePeriodMs ?? 15000): Promise<void> => {
    sponsorMonitorService.stop();
    ledgerIngestionWorker?.stop();
    stellarRouter?.stop();
    if (auditRootInterval) clearInterval(auditRootInterval);

    for (const socket of auditClients) {
      socket.close();
    }
    for (const socket of walletWebSocketServer.server.clients) {
      socket.close();
    }
    auditWebSocketServer.close();
    walletWebSocketServer.server.close();

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(checkInterval);
        resolve();
      };

      const timeout = setTimeout(() => {
        logger.error({ gracePeriodMs }, "Forced shutdown after grace period elapsed");
        finish();
      }, gracePeriodMs);
      if (typeof timeout.unref === "function") timeout.unref();

      // Stop accepting new connections; the callback fires once all in-flight
      // requests have completed.
      server.close(() => {
        logger.info("HTTP server closed");
        finish();
      });

      const checkInterval = setInterval(() => {
        if (activeRequests === 0) {
          server.close(() => {
            logger.info("HTTP server closed");
            finish();
          });
        }
      }, 100);
      if (typeof checkInterval.unref === "function") checkInterval.unref();
    });
  };

  return {
    app,
    server,
    client,
    stellarRouter,
    fraudDetector,
    cosignerService,
    feeSponsorService,
    sponsorMonitorService,
    ledgerIngestionWorker,
    policyEngine,
    webhookDispatcher,
    auditWebSocketServer,
    walletWebSocketServer: walletWebSocketServer.server,
    broadcastAuditEvent,
    broadcastWalletEvent,
    auditLog,
    shutdown,
  };
}
