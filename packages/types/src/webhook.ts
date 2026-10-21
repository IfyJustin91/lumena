export type WebhookEventType =
  | "wallet.created"
  | "transaction.cosigned"
  | "transaction.sponsored"
  | "transaction.fee_bump.submitted"
  | "policy.violated"
  | "balance.low"
  | "*";

export interface WebhookConfig {
  id: string;
  url: string;
  secret: string;
  events: WebhookEventType[];
  enabled?: boolean;
}

export interface WebhookPayload<T = unknown> {
  id: string;
  event: WebhookEventType;
  timestamp: string;
  data: T;
}

export interface WebhookDeliveryResult {
  webhookId: string;
  url: string;
  success: boolean;
  statusCode?: number;
  attempts: number;
  error?: string;
}

export interface WebhookDeliveryLogEntry extends WebhookDeliveryResult {
  deliveryId: string;
  event: WebhookEventType;
  timestamp: string;
  deliveredAt: string;
  data: unknown;
}

export type WebhookDeliveryStatus =
  | "pending"
  | "retrying"
  | "delivered"
  | "failed"
  | "dead_lettered";

export interface WebhookDeliveryRecord {
  id: string;
  webhookId: string;
  event: WebhookEventType;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastError?: string;
  nextRetryAt?: string;
  deadLettered: boolean;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
}