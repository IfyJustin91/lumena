import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";

export class ValidationError extends Error {
  statusCode: number;
  details?: unknown;

  constructor(message: string, details?: unknown, statusCode = 400) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class PolicyError extends Error {
  statusCode: number;
  code?: string;

  constructor(message: string, statusCode = 403, code?: string) {
    super(message);
    this.name = "PolicyError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class FraudError extends PolicyError {
  constructor(message: string, code = "FRAUD_DETECTED", statusCode = 403) {
    super(message, statusCode, code);
    this.name = "FraudError";
  }
}

export class StellarError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = "StellarError";
    this.statusCode = statusCode;
  }
}

export type TenantQuotaMetadata = {
  limit: number;
  remaining: number;
  reset: number;
  tier?: string;
  tenantId?: string;
};

export class TenantQuotaError extends Error {
  statusCode: number;
  metadata: TenantQuotaMetadata;

  constructor(message: string, metadata: TenantQuotaMetadata, statusCode = 429) {
    super(message);
    this.name = "TenantQuotaError";
    this.statusCode = statusCode;
    this.metadata = metadata;
  }
}

export type ErrorResponse = {
  error: string;
  details?: unknown;
};

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): Response => {
  logger.error({ err }, "Lumen error");

  if (err instanceof ValidationError) {
    return res.status(err.statusCode).json({
      error: err.message,
      details: err.details,
    });
  }

  if (err instanceof PolicyError) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
  }

  if (err instanceof TenantQuotaError) {
    const { limit, remaining, reset, tier, tenantId } = err.metadata;
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(reset));
    if (tier) {
      res.setHeader("X-RateLimit-Tier", tier);
    }
    if (tenantId) {
      res.setHeader("X-Tenant-Id", tenantId);
    }
    res.setHeader("Retry-After", String(Math.max(0, reset - Math.floor(Date.now() / 1000))));
    return res.status(err.statusCode).json({
      error: err.message,
      details: { limit, remaining, reset, ...(tier ? { tier } : {}) },
    });
  }

  if (err instanceof StellarError) {
    return res.status(err.statusCode).json({
      error: err.message,
    });
  }

  // Default unexpected error
  return res.status(500).json({
    error: "Internal server error",
  });
};

export const wrapHandler = (
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void> | void
) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await handler(req, res, next);
    } catch (err: any) {
      next(err);
    }
  };
};