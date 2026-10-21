import type { Transaction, Operation, Asset } from "@stellar/stellar-sdk";
import type {
  Policy,
  PolicyRule,
  SpendLimit,
  VelocityRule,
  AllowlistRule,
  BlocklistRule,
  AssetAllowlistRule,
  SessionKeyPolicyRule,
  TimeBoundsRule,
  MaxOperationsRule,
  FeeLimitRule,
  ContractAllowlistRule,
} from "@lumen/types";
import { validateTimeBounds } from "@lumen/core";

export interface EvaluateOpts {
  walletAddress: string;
  transaction: Transaction;
}

export interface EvaluateResult {
  approved: boolean;
  reason?: string;
}

export interface RuleEvaluationResult {
  index: number;
  type: PolicyRule["type"];
  approved: boolean;
  reason?: string;
  /** Remaining allowance after this rule is applied, when applicable. */
  remaining?: {
    /** Remaining velocity transactions within the window. */
    velocityRemaining?: number;
    /** Remaining daily spend allowance for the rule's asset. */
    spendRemaining?: string;
    /** Remaining session-key spend allowance. */
    sessionSpendRemaining?: string;
  };
}

export interface EvaluateWithDetailsResult {
  approved: boolean;
  reason?: string;
  results: RuleEvaluationResult[];
}

export interface PolicyEngineOptions {
  defaultPolicy?: "allow" | "deny";
}

export class PolicyEngine {
  private policies: Map<string, Policy> = new Map();
  private readonly defaultPolicy: "allow" | "deny";

  // In-memory tracking for spend limit and velocity
  private readonly spendTracking: Map<
    string,
    Map<string, { dailyTotal: number; txCount: number }>
  > = new Map();
  private readonly velocityTracking: Map<string, number[]> = new Map();
  private readonly sessionSpendTracking: Map<string, number> = new Map();

  constructor(options: PolicyEngineOptions = {}) {
    this.defaultPolicy = options.defaultPolicy ?? "allow";
  }

  addPolicy(policy: Policy): void {
    // Store the policy as-is so that the `version` field (used for ETag-based
    // optimistic concurrency control in the server) is preserved unchanged.
    this.policies.set(policy.walletId, policy);
  }

  removePolicy(walletId: string): void {
    this.policies.delete(walletId);
    this.spendTracking.delete(walletId);
    this.velocityTracking.delete(walletId);
  }

  /**
   * Invalidate the cached policy and all in-memory tracking state for a wallet.
   *
   * This is the entry point used by the Redis pub/sub subscriber
   * (`lumen:policies:updated`) so that every cluster replica drops stale
   * policy data as soon as an admin update is published. The next evaluation
   * for the wallet will fall back to the default policy until the updated
   * policy is re-loaded into the engine.
   */
  invalidatePolicy(walletId: string): void {
    this.removePolicy(walletId);
  }

  /**
   * Invalidate every cached policy and all tracking state.
   *
   * Useful when a bulk policy update event is received and the subscriber
   * cannot determine which wallets were affected.
   */
  invalidateAllPolicies(): void {
    this.policies.clear();
    this.spendTracking.clear();
    this.velocityTracking.clear();
    this.sessionSpendTracking.clear();
  }

  /**
   * Return the stored policy for a wallet, including its `version` field.
   *
   * The server uses this to compare the stored version against the
   * `If-Match` header on PUT /policy/:walletId.
   */
  getPolicy(walletId: string): Policy | null {
    return this.policies.get(walletId) ?? null;
  }

  listPolicies(): Policy[] {
    return Array.from(this.policies.values());
  }

  evaluate(opts: EvaluateOpts): EvaluateResult {
    const { approved, reason } = this.evaluateWithAudit(opts);
    return reason === undefined ? { approved } : { approved, reason };
  }

  evaluateWithAudit(opts: EvaluateOpts): EvaluateResult & { rulesEvaluated: string[] } {
    const rulesEvaluated: string[] = [];
    try {
      if (!opts || typeof opts !== "object") {
        return { approved: false, reason: "Malformed evaluation options", rulesEvaluated };
      }

      const policy = this.policies.get(opts.walletAddress);

      if (!policy) {
        return {
          approved: this.defaultPolicy === "allow",
          reason:
            this.defaultPolicy === "deny"
              ? `No policy found for wallet ${opts.walletAddress}`
              : undefined,
          rulesEvaluated,
        };
      }

      if (!Array.isArray(policy.rules)) {
        return { approved: false, reason: "Policy has malformed rules", rulesEvaluated };
      }

      for (const rule of policy.rules) {
        rulesEvaluated.push(typeof rule?.type === "string" ? rule.type : "unknown");
        const result = this.evaluateRule(rule, opts);
        if (!result.approved) {
          return { ...result, rulesEvaluated };
        }
      }

      return { approved: true, rulesEvaluated };
    } catch (err) {
      return {
        approved: false,
        reason: `Policy evaluation failed closed: ${err instanceof Error ? err.message : String(err)}`,
        rulesEvaluated,
      };
    }
  }

  private evaluateRule(rule: PolicyRule, opts: EvaluateOpts): EvaluateResult {
    try {
      if (!rule || typeof rule !== "object" || typeof rule.type !== "string") {
        return { approved: false, reason: "Malformed policy rule" };
      }

      switch (rule.type) {
        case "spend_limit":
          return this.evaluateSpendLimit(rule as SpendLimit, opts);
        case "velocity":
          return this.evaluateVelocity(rule as VelocityRule, opts);
        case "allowlist":
          return this.evaluateAllowlist(rule as AllowlistRule, opts);
        case "blocklist":
          return this.evaluateBlocklist(rule as BlocklistRule, opts);
        case "asset_allowlist":
          return this.evaluateAssetAllowlist(rule as AssetAllowlistRule, opts);
        case "session_key":
          return this.evaluateSessionKey(rule as SessionKeyPolicyRule, opts);
        case "timebounds":
          return this.evaluateTimeBounds(rule as TimeBoundsRule, opts);
        case "max_operations":
          return this.evaluateMaxOperations(rule as MaxOperationsRule, opts);
        case "fee_limit":
          return this.evaluateFeeLimit(rule as FeeLimitRule, opts);
        case "contract_allowlist":
          return this.evaluateContractAllowlist(rule as ContractAllowlistRule, opts);
        default:
          return { approved: false, reason: `Unknown policy rule type: ${rule.type}` };
      }
    } catch (err) {
      return {
        approved: false,
        reason: `Rule evaluation failed closed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private getOperations(opts: EvaluateOpts): Operation[] {
    const tx = opts?.transaction as unknown as { operations?: unknown } | undefined;
    if (!tx || !Array.isArray(tx.operations)) {
      return [];
    }
    return tx.operations as Operation[];
  }

  /**
   * Evaluate every rule in a wallet's policy and return the individual result
   * for each one, instead of short-circuiting on the first failure.
   *
   * This is intended for offline/dry-run tooling (e.g. the CLI policy
   * simulation command) that needs to display rule-by-rule outcomes.
   *
   * Note: this method is side-effect free. It does not mutate spend/velocity
   * tracking state, so it can be safely used for simulation.
   */
  evaluateWithDetails(opts: EvaluateOpts): EvaluateWithDetailsResult {
    const policy = this.policies.get(opts.walletAddress);

    if (!policy) {
      const approved = this.defaultPolicy === "allow";
      return {
        approved,
        reason: approved
          ? undefined
          : `No policy found for wallet ${opts.walletAddress}`,
        results: [],
      };
    }

    const results: RuleEvaluationResult[] = [];
    let firstFailure: string | undefined;

    policy.rules.forEach((rule, index) => {
      const result = this.evaluateRuleDryRun(rule, opts);
      const entry: RuleEvaluationResult = {
        index,
        type: rule.type,
        approved: result.approved,
        reason: result.reason,
        remaining: result.remaining,
      };
      results.push(entry);

      if (!result.approved && firstFailure === undefined) {
        firstFailure = result.reason;
      }
    });

    const approved = results.every((r) => r.approved);
    return {
      approved,
      reason: approved ? undefined : firstFailure,
      results,
    };
  }

  /**
   * Evaluate a single rule without mutating tracking state, returning the
   * result plus any remaining allowance information.
   */
  private evaluateRuleDryRun(
    rule: PolicyRule,
    opts: EvaluateOpts,
  ): { approved: boolean; reason?: string; remaining?: RuleEvaluationResult["remaining"] } {
    switch (rule.type) {
      case "velocity":
        return this.evaluateVelocityDryRun(rule as VelocityRule, opts);
      case "spend_limit":
        return this.evaluateSpendLimitDryRun(rule as SpendLimit, opts);
      case "session_key":
        return this.evaluateSessionKeyDryRun(rule as SessionKeyPolicyRule, opts);
      default: {
        const result = this.evaluateRule(rule, opts);
        return { approved: result.approved, reason: result.reason };
      }
    }
  }

  private evaluateVelocityDryRun(
    rule: VelocityRule,
    opts: EvaluateOpts,
  ): { approved: boolean; reason?: string; remaining?: RuleEvaluationResult["remaining"] } {
    const { walletAddress } = opts;
    const txTimes = this.velocityTracking.get(walletAddress) ?? [];

    const windowMs = rule.windowMinutes * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    const recentCount = txTimes.filter((t) => t > cutoff).length;

    // The simulated transaction would be the (recentCount + 1)-th in the window.
    const projectedCount = recentCount + 1;
    const velocityRemaining = Math.max(0, rule.maxTransactions - recentCount);

    if (projectedCount > rule.maxTransactions) {
      return {
        approved: false,
        reason: `Too many transactions (${projectedCount}) in ${rule.windowMinutes}-minute window (max: ${rule.maxTransactions})`,
        remaining: { velocityRemaining },
      };
    }

    return { approved: true, remaining: { velocityRemaining } };
  }

  private evaluateSpendLimitDryRun(
    rule: SpendLimit,
    opts: EvaluateOpts,
  ): { approved: boolean; reason?: string; remaining?: RuleEvaluationResult["remaining"] } {
    const { walletAddress } = opts;
    const targetAsset = this.getAssetIdentifier(rule.asset);

    let txAmount = 0;
    let matchedOps = 0;

    for (const op of opts.transaction.operations) {
      if (!("amount" in op) || typeof (op as { amount: unknown }).amount !== "string") {
        continue;
      }

      const typedOp = op as
        | Operation.Payment
        | Operation.PathPaymentStrictSend
        | Operation.PathPaymentStrictReceive;
      const opAsset: Asset | undefined =
        "asset" in typedOp
          ? (typedOp as Operation.Payment).asset
          : "sendAsset" in typedOp
            ? (typedOp as Operation.PathPaymentStrictSend).sendAsset
            : "destAsset" in typedOp
              ? (typedOp as Operation.PathPaymentStrictReceive).destAsset
              : undefined;
      const opAssetId = this.getAssetIdentifier(opAsset);

      if (opAssetId === targetAsset) {
        txAmount += parseFloat((typedOp as { amount: string }).amount);
        matchedOps++;
      }
    }

    if (matchedOps === 0) {
      return { approved: true };
    }

    const maxPerTx = parseFloat(rule.maxPerTx);
    const maxDaily = parseFloat(rule.maxDaily);

    if (txAmount > maxPerTx) {
      return {
        approved: false,
        reason: `Transaction spending ${txAmount} exceeds per-tx limit ${rule.maxPerTx}`,
      };
    }

    const today = new Date().toISOString().split("T")[0];
    const trackKey = `${today}:${targetAsset}`;
    const track = this.spendTracking.get(walletAddress)?.get(trackKey);
    const dailyTotal = track?.dailyTotal ?? 0;
    const projectedDaily = dailyTotal + txAmount;
    const spendRemaining = Math.max(0, maxDaily - projectedDaily);

    if (projectedDaily > maxDaily) {
      return {
        approved: false,
        reason: `Daily spending ${projectedDaily} exceeds limit ${rule.maxDaily}`,
        remaining: { spendRemaining: spendRemaining.toString() },
      };
    }

    return {
      approved: true,
      remaining: { spendRemaining: spendRemaining.toString() },
    };
  }

  private evaluateSessionKeyDryRun(
    rule: SessionKeyPolicyRule,
    opts: EvaluateOpts,
  ): { approved: boolean; reason?: string; remaining?: RuleEvaluationResult["remaining"] } {
    const now = Date.now();
    const expiryMs = rule.expiresAt < 1e11 ? rule.expiresAt * 1000 : rule.expiresAt;

    if (now > expiryMs) {
      return { approved: false, reason: `Session key ${rule.sessionPublicKey} has expired` };
    }

    const paymentOp = opts.transaction.operations.find(
      (op): op is Operation.Payment => "amount" in op && "destination" in op,
    ) as Operation.Payment | undefined;

    const txAmount = paymentOp ? parseFloat(paymentOp.amount) : 0;
    const currentSpend = this.sessionSpendTracking.get(rule.sessionPublicKey) ?? 0;
    const maxSpend = parseFloat(rule.maxSpend);
    const projectedSpend = currentSpend + txAmount;
    const sessionSpendRemaining = Math.max(0, maxSpend - projectedSpend);

    if (projectedSpend > maxSpend) {
      return {
        approved: false,
        reason: `Session key spend cap exceeded (${projectedSpend} > ${maxSpend})`,
        remaining: { sessionSpendRemaining: sessionSpendRemaining.toString() },
      };
    }

    return {
      approved: true,
      remaining: { sessionSpendRemaining: sessionSpendRemaining.toString() },
    };
  }



  private evaluateSpendLimit(rule: SpendLimit, opts: EvaluateOpts): EvaluateResult {
    const { walletAddress } = opts;
    const targetAsset = this.getAssetIdentifier(rule.asset);

    const maxPerTx = this.parseAmount(rule.maxPerTx);
    const maxDaily = this.parseAmount(rule.maxDaily);
    if (maxPerTx === null || maxDaily === null) {
      return { approved: false, reason: "Spend limit rule has malformed limits" };
    }

    let txAmount = 0;
    let matchedOps = 0;

    for (const op of this.getOperations(opts)) {
      // Type guard: only operations that carry an `amount` field (Payment, PathPayment, etc.)
      if (!("amount" in op) || typeof (op as { amount: unknown }).amount !== "string") {
        continue;
      }

      const typedOp = op as
        Operation.Payment | Operation.PathPaymentStrictSend | Operation.PathPaymentStrictReceive;
      const opAsset: Asset | undefined =
        "asset" in typedOp
          ? (typedOp as Operation.Payment).asset
          : "sendAsset" in typedOp
            ? (typedOp as Operation.PathPaymentStrictSend).sendAsset
            : "destAsset" in typedOp
              ? (typedOp as Operation.PathPaymentStrictReceive).destAsset
              : undefined;
      const opAssetId = this.getAssetIdentifier(opAsset);

      if (opAssetId === targetAsset) {
        const amount = this.parseAmount((typedOp as { amount: string }).amount);
        if (amount === null) {
          return { approved: false, reason: "Transaction contains a malformed amount" };
        }
        txAmount += amount;
        matchedOps++;
      }
    }

    if (matchedOps === 0) {
      return { approved: true };
    }

    if (txAmount > maxPerTx) {
      return {
        approved: false,
        reason: `Transaction spending ${txAmount} exceeds per-tx limit ${rule.maxPerTx}`,
      };
    }

    if (!this.spendTracking.has(walletAddress)) {
      this.spendTracking.set(walletAddress, new Map());
    }
    const walletTrack = this.spendTracking.get(walletAddress)!;
    const today = new Date().toISOString().split("T")[0];
    const trackKey = `${today}:${targetAsset}`;

    if (!walletTrack.has(trackKey)) {
      walletTrack.set(trackKey, { dailyTotal: 0, txCount: 0 });
    }
    const track = walletTrack.get(trackKey)!;

    if (txAmount > maxPerTx) {
      return {
        approved: false,
        reason: `Transaction spending ${txAmount} exceeds per-tx limit ${rule.maxPerTx}`,
      };
    }

    if (track.dailyTotal + txAmount > maxDaily) {
      return {
        approved: false,
        reason: `Daily spending ${track.dailyTotal + txAmount} exceeds limit ${rule.maxDaily}`,
      };
    }

    track.dailyTotal += txAmount;
    track.txCount++;

    return { approved: true };
  }

  private getAssetIdentifier(asset: Asset | string | undefined | null): string {
    try {
      if (!asset) return "native";
      if (typeof asset === "string") {
        if (asset.toLowerCase() === "native" || asset.toUpperCase() === "XLM") {
          return "native";
        }
        return asset;
      }
      if (typeof asset.isNative === "function" && asset.isNative()) {
        return "native";
      }
      if (asset.code && asset.issuer) {
        return `${asset.code}:${asset.issuer}`;
      }
      if (asset.code) {
        return asset.code;
      }
      return "native";
    } catch {
      // Malformed asset objects must not throw; treat as an opaque identifier
      // so that allowlist checks fail closed rather than bypassing.
      return "__malformed_asset__";
    }
  }

  private evaluateVelocity(rule: VelocityRule, opts: EvaluateOpts): EvaluateResult {
    const { walletAddress } = opts;

    if (
      !Number.isFinite(rule.windowMinutes) ||
      !Number.isFinite(rule.maxTransactions) ||
      rule.windowMinutes < 0
    ) {
      return { approved: false, reason: "Velocity rule has malformed parameters" };
    }

    // Initialize tracking for this wallet if needed
    if (!this.velocityTracking.has(walletAddress)) {
      this.velocityTracking.set(walletAddress, []);
    }
    const txTimes = this.velocityTracking.get(walletAddress)!;

    // Remove timestamps outside the window
    const windowMs = rule.windowMinutes * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    const recentTxs = txTimes.filter((t) => t > cutoff);

    // Add current transaction timestamp
    recentTxs.push(Date.now());

    // Update tracking
    this.velocityTracking.set(walletAddress, recentTxs);

    // Check if exceeding limit
    if (recentTxs.length > rule.maxTransactions) {
      return {
        approved: false,
        reason: `Too many transactions (${recentTxs.length}) in ${rule.windowMinutes}-minute window (max: ${rule.maxTransactions})`,
      };
    }

    return { approved: true };
  }

  private evaluateAllowlist(rule: AllowlistRule, opts: EvaluateOpts): EvaluateResult {
    if (!Array.isArray(rule.destinations)) {
      return { approved: false, reason: "Allowlist rule has malformed destinations" };
    }

    for (const op of this.getOperations(opts)) {
      if ("destination" in op && op.destination) {
        const destination = op.destination.toString();
        if (!rule.destinations.includes(destination)) {
          return {
            approved: false,
            reason: `Destination ${destination} is not on the allowlist`,
          };
        }
      }
    }

    return { approved: true };
  }

  private evaluateBlocklist(rule: BlocklistRule, opts: EvaluateOpts): EvaluateResult {
    if (!Array.isArray(rule.destinations)) {
      return { approved: false, reason: "Blocklist rule has malformed destinations" };
    }

    for (const op of this.getOperations(opts)) {
      if ("destination" in op && op.destination) {
        const destination = op.destination.toString();
        if (rule.destinations.includes(destination)) {
          return {
            approved: false,
            reason: `Destination ${destination} is on the blocklist`,
          };
        }
      }
    }

    return { approved: true };
  }

  private evaluateAssetAllowlist(rule: AssetAllowlistRule, opts: EvaluateOpts): EvaluateResult {
    if (!Array.isArray(rule.assets)) {
      return { approved: false, reason: "Asset allowlist rule has malformed assets" };
    }

    for (const op of this.getOperations(opts)) {
      let assets: Array<Asset | undefined> = [];
      if (op.type === "payment") {
        assets = [(op as Operation.Payment).asset];
      } else if (op.type === "pathPaymentStrictSend") {
        const pathPayment = op as Operation.PathPaymentStrictSend;
        assets = [pathPayment.sendAsset, pathPayment.destAsset];
      } else if (op.type === "pathPaymentStrictReceive") {
        const pathPayment = op as Operation.PathPaymentStrictReceive;
        assets = [pathPayment.sendAsset, pathPayment.destAsset];
      }

      for (const asset of assets) {
        const identifier = this.getAssetIdentifier(asset);
        if (!rule.assets.some((allowed) => this.getAssetIdentifier(allowed) === identifier)) {
          return {
            approved: false,
            reason: `Asset ${identifier} is not on the allowlist`,
          };
        }
      }
    }

    return { approved: true };
  }

  private evaluateSessionKey(rule: SessionKeyPolicyRule, opts: EvaluateOpts): EvaluateResult {
    const now = Date.now();

    if (!Number.isFinite(rule.expiresAt)) {
      return { approved: false, reason: "Session key rule has malformed expiry" };
    }

    const expiryMs = rule.expiresAt < 1e11 ? rule.expiresAt * 1000 : rule.expiresAt;

    if (now > expiryMs) {
      return { approved: false, reason: `Session key ${rule.sessionPublicKey} has expired` };
    }

    const paymentOp = this.getOperations(opts).find(
      (op): op is Operation.Payment => "amount" in op && "destination" in op,
    ) as Operation.Payment | undefined;

    let txAmount = 0;
    if (paymentOp) {
      const parsed = this.parseAmount(paymentOp.amount);
      if (parsed === null) {
        return { approved: false, reason: "Session key transaction has a malformed amount" };
      }
      txAmount = parsed;
    }

    const currentSpend = this.sessionSpendTracking.get(rule.sessionPublicKey) ?? 0;
    const maxSpend = this.parseAmount(rule.maxSpend);
    if (maxSpend === null) {
      return { approved: false, reason: "Session key rule has malformed spend cap" };
    }

    if (currentSpend + txAmount > maxSpend) {
      return {
        approved: false,
        reason: `Session key spend cap exceeded (${currentSpend + txAmount} > ${maxSpend})`,
      };
    }

    this.sessionSpendTracking.set(rule.sessionPublicKey, currentSpend + txAmount);
    return { approved: true };
  }

  private evaluateTimeBounds(rule: TimeBoundsRule, opts: EvaluateOpts): EvaluateResult {
    if (!opts?.transaction) {
      return { approved: false, reason: "Time bounds rule received a malformed transaction" };
    }

    const result = validateTimeBounds(opts.transaction, {
      maxWindowSeconds: rule.maxWindowSeconds,
      allowUnbounded: rule.allowUnbounded ?? false,
    });

    if (!result.valid) {
      return { approved: false, reason: result.reason };
    }

    return { approved: true };
  }

  evaluateMaxOperations(
    rule: MaxOperationsRule,
    optsOrTx: EvaluateOpts | Transaction | { operations: unknown[] },
  ): EvaluateResult {
    if (!Number.isFinite(rule.maxOperations) || rule.maxOperations < 0) {
      return { approved: false, reason: "Max operations rule has malformed limit" };
    }

    const tx =
      "transaction" in optsOrTx
        ? (optsOrTx as EvaluateOpts).transaction
        : (optsOrTx as { operations: unknown[] });
    const opCount = Array.isArray(tx?.operations) ? tx.operations.length : 0;
    if (opCount > rule.maxOperations) {
      return {
        approved: false,
        reason: `Transaction operation count ${opCount} exceeds limit of ${rule.maxOperations}`,
      };
    }

    return { approved: true };
  }

  private evaluateFeeLimit(rule: FeeLimitRule, opts: EvaluateOpts): EvaluateResult {
    if (!Number.isFinite(rule.maxFeeStroops)) {
      return { approved: false, reason: "Fee limit rule has malformed limit" };
    }

    const rawFee = (opts?.transaction as unknown as { fee?: unknown } | undefined)?.fee;
    const fee = typeof rawFee === "number" ? rawFee : parseInt(String(rawFee), 10);
    if (!Number.isFinite(fee)) {
      return { approved: false, reason: "Transaction has a malformed fee" };
    }

    if (fee > rule.maxFeeStroops) {
      return {
        approved: false,
        reason: `Transaction fee exceeds maximum allowed fee limit`,
      };
    }

    return { approved: true };
  }

  private evaluateContractAllowlist(rule: ContractAllowlistRule, opts: EvaluateOpts): EvaluateResult {
    for (const op of opts.transaction.operations) {
      // Soroban contract invocations have type 'invokeHostFunction'
      if (op.type !== "invokeHostFunction") {
        continue;
      }

      const invokeOp = op as unknown as {
        type: string;
        func?: {
          contractAddress?: { contractId?: () => string; toString?: () => string };
          functionName?: string;
        };
      };

      // Extract the contract ID from the host function
      const contractId =
        invokeOp.func?.contractAddress?.contractId?.() ??
        invokeOp.func?.contractAddress?.toString?.() ??
        null;

      if (!contractId) {
        return {
          approved: false,
          reason: "Contract invocation is missing a contract address",
        };
      }

      const allowedEntry = rule.allowedContracts.find(
        (c: { contractId: string; methods?: string[] }) => c.contractId === contractId,
      );

      if (!allowedEntry) {
        return {
          approved: false,
          reason: `Contract ${contractId} is not in the allowlist`,
        };
      }

      // If methods are specified, verify the invoked function matches
      if (allowedEntry.methods && allowedEntry.methods.length > 0) {
        const invokedMethod = invokeOp.func?.functionName;
        if (!invokedMethod || !allowedEntry.methods.includes(invokedMethod)) {
          return {
            approved: false,
            reason: `Method ${invokedMethod ?? "(unknown)"} is not allowed for contract ${contractId}`,
          };
        }
      }
    }

    return { approved: true };
  }
}
