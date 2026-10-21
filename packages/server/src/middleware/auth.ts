import type { Request, Response, NextFunction } from "express";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ValidationError } from "../errors.js";

export type Role = "admin" | "operator" | "auditor";

export interface AuthUser {
  id: string;
  role: Role;
}

export type TenantTier = "free" | "pro" | "enterprise";

export interface Tenant {
  id: string;
  name: string;
  apiKeyHash: string;
  tier: TenantTier;
  monthlyGasQuotaXlm: number;
  monthlyGasUsedXlm: number;
  allowedDomains: string[];
}

export interface TenantStore {
  findByApiKeyHash(hash: string): Tenant | undefined;
  get(id: string): Tenant | undefined;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      tenant?: Tenant;
    }
  }
}

export interface AuthMiddlewareOpts {
  apiKey?: string;
  jwtSecret?: string;
  tenantStore?: TenantStore;
}

/**
 * Hash a presented API key with SHA-256 (hex) for lookup against stored hashes.
 */
export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function extractOriginHost(origin: string | undefined): string | undefined {
  if (!origin) {
    return undefined;
  }
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isDomainAllowed(origin: string | undefined, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) {
    return true;
  }
  const host = extractOriginHost(origin);
  if (!host) {
    return false;
  }
  return allowedDomains.some((domain) => {
    const normalized = domain.toLowerCase().trim();
    if (normalized.startsWith("*.")) {
      const suffix = normalized.slice(1); // ".example.com"
      return host.endsWith(suffix) || host === normalized.slice(2);
    }
    return host === normalized;
  });
}

interface JwtPayload {
  sub?: string;
  id?: string;
  role?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  [key: string]: unknown;
}

const VALID_ROLES: ReadonlySet<Role> = new Set<Role>(["admin", "operator", "auditor"]);

function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(normalized, "base64");
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify an HS256 JWT and return its decoded payload, or null if invalid.
 */
function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
  } catch {
    return null;
  }

  if (!header || header.alg !== "HS256") {
    return null;
  }

  const expectedSig = base64UrlEncode(
    createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest(),
  );

  if (!safeEqual(expectedSig, signatureB64)) {
    return null;
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now >= payload.exp) {
    return null;
  }
  if (typeof payload.nbf === "number" && now < payload.nbf) {
    return null;
  }

  return payload;
}

function extractUser(payload: JwtPayload): AuthUser | null {
  const id = typeof payload.sub === "string" ? payload.sub : typeof payload.id === "string" ? payload.id : undefined;
  const role = typeof payload.role === "string" ? (payload.role as Role) : undefined;

  if (!id || !role || !VALID_ROLES.has(role)) {
    return null;
  }

  return { id, role };
}

function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

export function apiKeyAuth(opts: AuthMiddlewareOpts = {}) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const expectedKey = opts.apiKey || process.env.LUMEN_API_KEY;
    const jwtSecret = opts.jwtSecret || process.env.LUMEN_JWT_SECRET;
    const tenantStore = opts.tenantStore;

    const headerKey = req.headers["x-api-key"] as string | undefined;
    const authHeader = req.headers.authorization;
    const bearerKey =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.substring(7)
        : undefined;

    // Attempt JWT verification when a bearer token is present and a secret is configured.
    if (bearerKey && jwtSecret && looksLikeJwt(bearerKey)) {
      const payload = verifyJwt(bearerKey, jwtSecret);
      if (payload) {
        const user = extractUser(payload);
        if (user) {
          req.user = user;
          return next();
        }
      }
      // Invalid JWT: fall through to API-key checks (if any) or reject below.
    }

    const providedKey = headerKey || bearerKey;

    // Tenant-aware authentication takes precedence when a store is configured.
    if (tenantStore) {
      if (!providedKey) {
        return next(
          new ValidationError("Unauthorized: Invalid or missing API key", undefined, 401),
        );
      }

      const tenant = tenantStore.findByApiKeyHash(hashApiKey(providedKey));
      if (!tenant) {
        return next(
          new ValidationError("Unauthorized: Invalid or missing API key", undefined, 401),
        );
      }

      const origin = req.headers.origin as string | undefined;
      if (!isDomainAllowed(origin, tenant.allowedDomains)) {
        return next(
          new ValidationError("Forbidden: Origin not allowed for this tenant", undefined, 403),
        );
      }

      req.tenant = tenant;
      return next();
    }

    // If no API key configured in server environment/options, pass through
    if (!expectedKey) {
      return next();
    }

    if (!providedKey || providedKey !== expectedKey) {
      return next(
        new ValidationError("Unauthorized: Invalid or missing API key", undefined, 401),
      );
    }

    next();
  };
}

function startOfNextMonthUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/**
 * Enforce the tenant's monthly gas quota. Returns 429 with descriptive
 * rate-limit headers when the quota is exhausted.
 */
export function tenantQuota(opts: { tenantStore?: TenantStore } = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const tenant = req.tenant;
    if (!tenant) {
      return next();
    }

    const store = opts.tenantStore;
    const current = (store && store.get(tenant.id)) || tenant;
    const limit = current.monthlyGasQuotaXlm;
    const used = current.monthlyGasUsedXlm;
    const remaining = Math.max(0, limit - used);
    const reset = Math.floor(startOfNextMonthUtc().getTime() / 1000);

    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(reset));

    if (used >= limit) {
      const retryAfter = Math.max(1, reset - Math.floor(Date.now() / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return next(
        new ValidationError(
          `Too Many Requests: monthly gas quota of ${limit} XLM exhausted for tenant ${current.id}`,
          undefined,
          429,
        ),
      );
    }

    next();
  };
}