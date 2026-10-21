import type { Keypair, Asset } from "@stellar/stellar-sdk";
import { Operation, TransactionBuilder, BASE_FEE, Memo } from "@stellar/stellar-sdk";
import type { StellarClient } from "../stellar/client.js";
import { createSponsoredAccount } from "../stellar/account.js";
import { setupMultisig } from "../stellar/multisig.js";
import { KeyManager } from "../keys/manager.js";
import { ContractClient } from "../soroban/client.js";
import type { ContractSimulationResult, OperationSpec, ScValInput } from "@lumen/types";

export interface WalletOpts {
  client: StellarClient;
  /**
   * The sponsor keypair used to pay account creation reserves and transaction
   * fees. Required when the wallet itself calls `createSponsoredAccount` and
   * `setupMultisig` directly (e.g. server-side usage).
   *
   * In browser environments this MUST be omitted — account creation and fee
   * sponsorship are handled exclusively by calling the backend REST endpoints
   * (`POST /wallet/create`, `POST /fee-bump/submit`). Passing this field from
   * browser code is a severe security vulnerability and is now deprecated.
   *
   * @deprecated Pass `serverUrl` instead and let the server handle sponsorship.
   */
  sponsorKeypair?: Keypair;
  serverPublicKey: string;
  serverUrl?: string;
  ownerKeypair?: Keypair;
  /**
   * Optional KeyManager instance to inject. If not provided, a new default
   * KeyManager is created internally. Inject a custom instance to use another
   * persistent storage backend or to facilitate unit testing.
   */
  keyManager?: KeyManager;
}

export interface WalletRegistry {
  register(address: string): Promise<void> | void;
  list(): Promise<string[]> | string[];
}

/** Result of validating a cross-contract invocation against the policy-guard registry. */
export interface CrossContractValidationResult {
  /** Whether every call target is registered and verified in the policy-guard. */
  allowed: boolean;
  /** The call targets that were rejected (empty when `allowed` is true). */
  rejectedTargets: string[];
}

/** Result of a USD spend-limit check performed via the oracle consumer contract. */
export interface UsdSpendLimitResult {
  /** Whether the spend is within the configured USD limit. */
  allowed: boolean;
  /** USD value of the spend, expressed in the oracle's base units as a string. */
  usdValue: string;
  /** The configured USD limit, expressed in the oracle's base units as a string. */
  limit: string;
}

/** Options for requesting a proxy upgrade (issue #224). */
export interface ProxyUpgradeRequest {
  /** Address of the proxy contract to upgrade. */
  proxyContractId: string;
  /** Hex-encoded hash of the new contract WASM. */
  newWasmHash: string;
  /** Optional fee override for the invocation transaction. */
  fee?: string;
}

/** Result of an inheritance heartbeat or claim (issue #225). */
export interface InheritanceStatus {
  /** The last recorded heartbeat timestamp (unix seconds). */
  lastHeartbeat: number;
  /** The configured dormancy period in seconds. */
  dormancyPeriod: number;
}

export class InMemoryWalletRegistry implements WalletRegistry {
  private addresses: string[] = [];

  register(address: string): void {
    if (!this.addresses.includes(address)) {
      this.addresses.push(address);
    }
  }

  list(): string[] {
    return [...this.addresses];
  }
}

export class Wallet {
  private client: StellarClient;
  private sponsorKeypair: Keypair | null;
  private serverPublicKey: string;
  private serverUrl?: string;
  private keyManager: KeyManager;
  private _address: string | null = null;
  private _keypair: Keypair | null = null;
  private initialOwnerKeypair?: Keypair;
  private analytics: {
    totalTransactions: number;
    totalXlmVolume: bigint;
    policyViolations: number;
    lastTransactionAt: string | null;
  } = {
    totalTransactions: 0,
    totalXlmVolume: 0n,
    policyViolations: 0,
    lastTransactionAt: null,
  };

  constructor(opts: WalletOpts) {
    this.client = opts.client;
    this.sponsorKeypair = opts.sponsorKeypair ?? null;
    this.serverPublicKey = opts.serverPublicKey;
    this.serverUrl = opts.serverUrl?.replace(/\/+$/, "");
    this.initialOwnerKeypair = opts.ownerKeypair;
    this.keyManager = opts.keyManager ?? new KeyManager();
    if (opts.ownerKeypair) {
      this._keypair = opts.ownerKeypair;
    }
  }

  /** Returns the on-chain account address after the wallet has been created. */
  get address(): string {
    if (!this._address) throw new Error("Wallet not created yet");
    return this._address;
  }

  /** Creates, sponsors, configures multisig for, and stores the wallet account. */
  async create(): Promise<{ address: string; publicKey: string }> {
    if (!this.sponsorKeypair) {
      throw new Error(
        "Wallet.create() requires a sponsorKeypair. " +
          "In browser environments, use LumenClient.createWallet() which delegates " +
          "account creation to the backend server (POST /wallet/create) without " +
          "exposing the sponsor secret key.",
      );
    }

    if (!this._keypair) {
      this._keypair = this.keyManager.generateKeypair();
    }

    await createSponsoredAccount({
      client: this.client,
      sponsorKeypair: this.sponsorKeypair,
      newAccountKeypair: this._keypair,
    });

    await setupMultisig({
      client: this.client,
      accountKeypair: this._keypair,
      coSignerPublicKey: this.serverPublicKey,
    });

    this._address = this._keypair.publicKey();
    this.keyManager.store(this._keypair, "default");

    return { address: this._address, publicKey: this._address };
  }

  /** Reads the wallet balance for native XLM or the provided Stellar asset. */
  async getBalance(asset?: Asset): Promise<string> {
    const account = await this.client.horizon.loadAccount(this.address);

    if (!asset || asset.isNative()) {
      const balance = account.balances.find((b: any) => b.asset_type === "native");
      return balance?.balance ?? "0";
    }

    const balance = account.balances.find(
      (b: any) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
    );
    return (balance as any)?.balance ?? "0";
  }

  /** Builds, signs, and submits a payment from the wallet account. */
  async send(
    destination: string,
    asset: Asset,
    amount: string,
    memo?: Memo | string,
  ): Promise<{ hash: string }> {
    if (!this._keypair) throw new Error("Wallet not initialized");
    if (!this.serverUrl) {
      throw new Error("A Lumen server URL is required to send payments through policy enforcement");
    }

    const signedXdr = await this.buildPaymentTransaction(destination, asset, amount, memo);
    const cosignResponse = await fetch(`${this.serverUrl}/cosign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xdr: signedXdr, walletAddress: this.address }),
    });
    if (!cosignResponse.ok) {
      const details = await cosignResponse.text();
      throw new Error(
        `Cosign rejected with status ${cosignResponse.status}${details ? `: ${details}` : ""}`,
      );
    }

    const cosignResult: unknown = await cosignResponse.json();
    if (
      typeof cosignResult !== "object" ||
      cosignResult === null ||
      !("signedXdr" in cosignResult) ||
      typeof cosignResult.signedXdr !== "string" ||
      cosignResult.signedXdr.length === 0
    ) {
      throw new Error("Cosign response did not contain a signed transaction");
    }

    const submitResponse = await fetch(`${this.serverUrl}/fee-bump/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xdr: cosignResult.signedXdr }),
    });
    if (!submitResponse.ok) {
      const details = await submitResponse.text();
      throw new Error(
        `Fee-bump submission failed with status ${submitResponse.status}${details ? `: ${details}` : ""}`,
      );
    }

    const submitResult: unknown = await submitResponse.json();
    if (
      typeof submitResult !== "object" ||
      submitResult === null ||
      !("hash" in submitResult) ||
      typeof submitResult.hash !== "string" ||
      submitResult.hash.length === 0
    ) {
      throw new Error("Fee-bump response did not contain a transaction hash");
    }

    this.recordTransaction(asset, amount);
    return { hash: submitResult.hash };
  }

  async buildPaymentTransaction(
    destination: string,
    asset: Asset,
    amount: string,
    memo?: Memo | string,
  ): Promise<string> {
    if (!this._keypair) throw new Error("Wallet not initialized");

    const account = await this.client.horizon.loadAccount(this.address);

    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.client.networkPassphrase,
    }).addOperation(
      Operation.payment({
        destination,
        asset,
        amount,
      }),
    );

    if (memo !== undefined) {
      builder.addMemo(typeof memo === "string" ? Memo.text(memo) : memo);
    }

    const tx = builder.setTimeout(180).build();
    tx.sign(this._keypair);
    return tx.toXDR();
  }

  async buildTransaction(operations: OperationSpec[]): Promise<string> {
    if (!this._keypair) throw new Error("Wallet not initialized");
    if (operations.length === 0) {
      throw new Error("At least one operation is required");
    }

    const account = await this.client.horizon.loadAccount(this.address);

    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.client.networkPassphrase,
    });

    for (const spec of operations) {
      builder.addOperation(this.toOperation(spec));
    }

    const tx = builder.setTimeout(180).build();
    tx.sign(this._keypair);
    return tx.toXDR();
  }

  private toOperation(spec: OperationSpec): any {
    switch (spec.type) {
      case "payment":
        return Operation.payment({
          destination: spec.destination,
          asset: spec.asset,
          amount: spec.amount,
        });
      case "createAccount":
        return Operation.createAccount({
          destination: spec.destination,
          startingBalance: spec.startingBalance,
        });
      case "changeTrust":
        return Operation.changeTrust({ asset: spec.asset });
      case "manageData":
        return Operation.manageData({
          name: spec.name,
          value: spec.value ?? null,
        });
      default: {
        const exhaustive: never = spec;
        throw new Error(`Unsupported operation type: ${(exhaustive as any).type}`);
      }
    }
  }

  /**
   * Establish or modify a trustline for this wallet account.
   * Pass `limit = '0'` to remove the trustline.
   */
  async changeTrust(asset: Asset, limit?: string): Promise<{ hash: string }> {
    if (!this._keypair) throw new Error("Wallet not initialized");

    const account = await this.client.horizon.loadAccount(this.address);
    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.client.networkPassphrase,
    });

    builder.addOperation(Operation.changeTrust({ asset, limit }));
    const tx = builder.setTimeout(180).build();
    tx.sign(this._keypair);

    const result = await this.client.horizon.submitTransaction(tx as any);
    return { hash: result.hash };
  }

  async simulateContract(
    contractId: string,
    method: string,
    args?: ScValInput[],
  ): Promise<ContractSimulationResult> {
    const contractClient = new ContractClient(this.client);
    return contractClient.simulate({ contractId, method, args }, this.address);
  }

  async buildContractInvocationTransaction(
    contractId: string,
    method: string,
    args?: ScValInput[],
    fee?: string,
  ): Promise<string> {
    if (!this._keypair) throw new Error("Wallet not initialized");

    const contractClient = new ContractClient(this.client);
    const tx = await contractClient.buildTransaction({
      sourceAddress: this.address,
      invocation: { contractId, method, args },
      fee,
    });

    tx.sign(this._keypair);
    return tx.toXDR();
  }

  async invokeContract(
    contractId: string,
    method: string,
    args?: ScValInput[],
    fee?: string,
  ): Promise<{ hash: string }> {
    if (!this._keypair) throw new Error("Wallet not initialized");

    const xdr = await this.buildContractInvocationTransaction(contractId, method, args, fee);
    const parsed = TransactionBuilder.fromXDR(xdr, this.client.networkPassphrase);

    const result = await this.client.horizon.submitTransaction(parsed as any);
    if (result.successful) {
      this.recordTransaction(undefined, undefined);
      return { hash: result.hash };
    }

    throw new Error(`Contract invocation failed: ${result.hash}`);
  }

  /**
   * Validates a set of cross-contract call targets against the policy-guard
   * registry (issue #222). Unregistered targets are rejected; registered
   * targets are permitted to execute.
   *
   * @param policyGuardContractId Address of the deployed policy-guard contract.
   * @param callTargets Contract addresses that the batch will invoke.
   */
  async validateCrossContractInvocation(
    policyGuardContractId: string,
    callTargets: string[],
  ): Promise<CrossContractValidationResult> {
    if (callTargets.length === 0) {
      return { allowed: true, rejectedTargets: [] };
    }

    const contractClient = new ContractClient(this.client);
    const rejectedTargets: string[] = [];

    for (const target of callTargets) {
      const simulation = await contractClient.simulate(
        {
          contractId: policyGuardContractId,
          method: "is_registered",
          args: [{ type: "address", value: target }],
        },
        this.address,
      );

      if (!this.isTruthySimulationResult(simulation)) {
        rejectedTargets.push(target);
      }
    }

    return { allowed: rejectedTargets.length === 0, rejectedTargets };
  }

  /**
   * Invokes a contract only after validating every cross-contract call target
   * against the policy-guard registry (issue #222). Throws when any target is
   * unregistered so that execution is never dispatched.
   */
  async invokeContractWithPolicyGuard(
    policyGuardContractId: string,
    contractId: string,
    method: string,
    args?: ScValInput[],
    callTargets: string[] = [],
    fee?: string,
  ): Promise<{ hash: string }> {
    const validation = await this.validateCrossContractInvocation(
      policyGuardContractId,
      callTargets,
    );
    if (!validation.allowed) {
      this.recordPolicyViolation();
      throw new Error(
        `Cross-contract invocation rejected: unregistered targets ${validation.rejectedTargets.join(", ")}`,
      );
    }

    return this.invokeContract(contractId, method, args, fee);
  }

  /**
   * Checks whether a spend is within the configured USD limit using the oracle
   * consumer contract (issue #223). Fails safely when the oracle price is stale
   * or missing by treating the spend as disallowed.
   *
   * @param oracleSpendLimitContractId Address of the oracle-spend-limit contract.
   * @param asset Address (or symbol) of the asset being spent.
   * @param amount Amount of the asset, in its smallest unit, as a string.
   */
  async checkUsdSpendLimit(
    oracleSpendLimitContractId: string,
    asset: string,
    amount: string,
  ): Promise<UsdSpendLimitResult> {
    const contractClient = new ContractClient(this.client);
    const simulation = await contractClient.simulate(
      {
        contractId: oracleSpendLimitContractId,
        method: "check_spend_limit",
        args: [
          { type: "address", value: this.address },
          { type: "address", value: asset },
          { type: "i128", value: amount },
        ],
      },
      this.address,
    );

    const parsed = this.parseUsdSpendLimitResult(simulation);
    if (!parsed) {
      // Fail safely: a stale or missing oracle price must never authorize a spend.
      return { allowed: false, usdValue: "0", limit: "0" };
    }
    return parsed;
  }

  /**
   * Requests an upgrade of a proxy contract (issue #224). The proxy enforces
   * multi-sig approval and a mandatory timelock on-chain; this method only
   * submits the upgrade request.
   */
  async requestProxyUpgrade(request: ProxyUpgradeRequest): Promise<{ hash: string }> {
    return this.invokeContract(
      request.proxyContractId,
      "propose_upgrade",
      [{ type: "bytes", value: request.newWasmHash }],
      request.fee,
    );
  }

  /**
   * Sends an inheritance heartbeat to the vault contract (issue #225),
   * resetting the dormancy timer.
   */
  async sendInheritanceHeartbeat(inheritanceContractId: string): Promise<{ hash: string }> {
    return this.invokeContract(inheritanceContractId, "heartbeat");
  }

  /**
   * Claims custody of an inheritance vault as the designated beneficiary
   * (issue #225). The contract rejects the claim while the heartbeat is active.
   */
  async claimInheritance(inheritanceContractId: string): Promise<{ hash: string }> {
    return this.invokeContract(inheritanceContractId, "claim");
  }

  /** Reads the current inheritance vault status (issue #225). */
  async getInheritanceStatus(inheritanceContractId: string): Promise<InheritanceStatus> {
    const contractClient = new ContractClient(this.client);
    const simulation = await contractClient.simulate(
      { contractId: inheritanceContractId, method: "get_status" },
      this.address,
    );

    const parsed = this.parseInheritanceStatus(simulation);
    if (!parsed) {
      throw new Error("Unable to read inheritance status from contract");
    }
    return parsed;
  }

  private isTruthySimulationResult(simulation: ContractSimulationResult): boolean {
    const result: unknown = (simulation as any)?.result;
    if (typeof result === "boolean") return result;
    if (typeof result === "string") return result === "true" || result === "1";
    if (typeof result === "object" && result !== null && "value" in result) {
      const value = (result as any).value;
      if (typeof value === "boolean") return value;
      if (typeof value === "string") return value === "true" || value === "1";
    }
    return false;
  }

  private parseUsdSpendLimitResult(
    simulation: ContractSimulationResult,
  ): UsdSpendLimitResult | null {
    const result: unknown = (simulation as any)?.result;
    if (typeof result !== "object" || result === null) return null;

    const allowed = (result as any).allowed;
    const usdValue = (result as any).usd_value ?? (result as any).usdValue;
    const limit = (result as any).limit;

    if (typeof allowed !== "boolean") return null;
    if (usdValue === undefined || limit === undefined) return null;

    return {
      allowed,
      usdValue: String(usdValue),
      limit: String(limit),
    };
  }

  private parseInheritanceStatus(
    simulation: ContractSimulationResult,
  ): InheritanceStatus | null {
    const result: unknown = (simulation as any)?.result;
    if (typeof result !== "object" || result === null) return null;

    const lastHeartbeat = (result as any).last_heartbeat ?? (result as any).lastHeartbeat;
    const dormancyPeriod = (result as any).dormancy_period ?? (result as any).dormancyPeriod;

    if (lastHeartbeat === undefined || dormancyPeriod === undefined) return null;

    return {
      lastHeartbeat: Number(lastHeartbeat),
      dormancyPeriod: Number(dormancyPeriod),
    };
  }

  private recordTransaction(asset: Asset | undefined, amount: string | undefined): void {
    this.analytics.totalTransactions += 1;
    this.analytics.lastTransactionAt = new Date().toISOString();

    if (asset && asset.isNative() && amount) {
      const stroops = this.toStroops(amount);
      if (stroops !== null) {
        this.analytics.totalXlmVolume += stroops;
      }
    }
  }

  private toStroops(amount: string): bigint | null {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
    if (!match) return null;
    const whole = BigInt(match[1]);
    const fraction = (match[2] ?? "").padEnd(7, "0").slice(0, 7);
    return whole * 10_000_000n + BigInt(fraction);
  }

  private fromStroops(stroops: bigint): string {
    const whole = stroops / 10_000_000n;
    const fraction = (stroops % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
    return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
  }

  recordPolicyViolation(): void {
    this.analytics.policyViolations += 1;
  }

  getAnalytics(): WalletAnalytics {
    return {
      address: this.address,
      totalTransactions: this.analytics.totalTransactions,
      totalXlmVolume: this.fromStroops(this.analytics.totalXlmVolume),
      policyViolations: this.analytics.policyViolations,
      lastTransactionAt: this.analytics.lastTransactionAt,
    };
  }

  getAddress(): string {
    return this.address;
  }
}
