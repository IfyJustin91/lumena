export interface Policy {
  id: string;
  walletId: string;
  rules: PolicyRule[];
  createdAt: Date;
  /**
   * Optimistic concurrency version. Starts at 1 when the policy is created and
   * is incremented on every update. Used to detect lost updates via If-Match.
   */
  version: number;
}

export type PolicyRule =
  | SpendLimit
  | VelocityRule
  | AllowlistRule
  | BlocklistRule
  | AssetAllowlistRule
  | SessionKeyPolicyRule
  | TimeBoundsRule
  | MaxOperationsRule
  | FeeLimitRule
  | ContractAllowlistRule
  | ContractInvocationPolicyRule
  | UsdSpendLimitRule;

export interface SpendLimit {
  type: "spend_limit";
  asset: string;
  maxPerTx: string;
  maxDaily: string;
}

export interface VelocityRule {
  type: "velocity";
  maxTransactions: number;
  windowMinutes: number;
}

export interface AllowlistRule {
  type: "allowlist";
  destinations: string[];
}

export interface BlocklistRule {
  type: "blocklist";
  destinations: string[];
}

export interface AssetAllowlistRule {
  type: "asset_allowlist";
  assets: string[];
}

export interface SessionKeyPolicyRule {
  type: "session_key";
  sessionPublicKey: string;
  maxSpend: string;
  expiresAt: number;
}

export interface TimeBoundsRule {
  type: "timebounds";
  maxWindowSeconds?: number;
  allowUnbounded?: boolean;
}

export interface MaxOperationsRule {
  type: "max_operations";
  maxOperations: number;
}

export interface FeeLimitRule {
  type: "fee_limit";
  maxFeeStroops: number;
}

export interface ContractAllowlistRule {
  type: "contract_allowlist";
  allowedContracts: Array<{
    contractId: string;
    /** If omitted or empty, all methods are allowed for this contract. */
    methods?: string[];
  }>;
}

/**
 * Cross-contract invocation policy (#222).
 *
 * Enforces that every sub-contract dispatched by the wallet is registered in
 * the on-chain verified contract registry and, optionally, that the invoked
 * method is explicitly authorized.
 */
export interface ContractInvocationPolicyRule {
  type: "contract_invocation";
  /** Address of the on-chain verified contract registry contract. */
  registryContractId: string;
  /** If true, only contracts present in the registry may be invoked. */
  requireVerified: boolean;
  /** Optional per-contract method allowlist; empty/omitted means all methods. */
  authorizedTargets?: Array<{
    contractId: string;
    /** Expected verified source-code hash (hex) for the target contract. */
    codeHash?: string;
    /** If omitted or empty, all methods are allowed for this contract. */
    methods?: string[];
  }>;
}

/**
 * USD-denominated spend limit backed by an on-chain price oracle (#223).
 *
 * Asset amounts are converted to USD using the configured oracle before the
 * payment is authorized. Stale or missing prices cause a safe failure.
 */
export interface UsdSpendLimitRule {
  type: "usd_spend_limit";
  /** Address of the oracle price-feed consumer contract. */
  oracleContractId: string;
  /** Maximum acceptable age of an oracle price, in seconds. */
  maxPriceAgeSeconds: number;
  /** Maximum USD value allowed per transaction (decimal string). */
  maxPerTxUsd: string;
  /** Maximum USD value allowed per rolling day (decimal string). */
  maxDailyUsd: string;
  /** Assets subject to the USD limit; empty/omitted means all assets. */
  assets?: string[];
}

export interface PolicyStore {
  getPolicy(walletId: string): Promise<Policy | null>;
  savePolicy(policy: Policy): Promise<void>;
  deletePolicy(walletId: string): Promise<void>;
  listPolicies(): Promise<Policy[]>;
  recordSpend(
    walletId: string,
    date: string,
    amount: number,
    asset?: string,
  ): Promise<{ dailyTotal: number; txCount: number }>;
  recordVelocity(walletId: string, timestamp: number, windowMs: number): Promise<number>;
}
