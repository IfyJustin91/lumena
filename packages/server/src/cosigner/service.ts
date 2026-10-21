import { TransactionBuilder, Transaction, Keypair, xdr } from "@stellar/stellar-sdk";
import type { Signer } from "@lumen/types";
import { validateTimeBounds, type StellarClient } from "@lumen/core";
import type { PolicyEngine } from "../policy/engine.js";
import type { WebhookDispatcher } from "../webhook/dispatcher.js";
import { trackOperation } from "../lifecycle.js";
import type { SequenceAllocator } from "../fee-sponsor/sequence-allocator.js";

export interface CosignerOpts {
  client: StellarClient;
  /** Production: use an AwsKmsSigner. Dev/testnet: use an EnvSigner. */
  signer: Signer;
  policyEngine: PolicyEngine;
  enforceTimeBounds?: boolean;
  maxValidityWindowSeconds?: number;
  webhookDispatcher?: WebhookDispatcher;
  /** Optional real-time fraud/anomaly detector. */
  fraudDetector?: FraudDetector;
  /**
   * Optional distributed sequence number allocator. When provided, the
   * co-signer reserves a sequence number for the sponsor account before
   * signing and retries submission with exponential backoff on
   * `txBAD_SEQ` collisions.
   */
  sequenceAllocator?: SequenceAllocator;
  /** Max retry attempts on `txBAD_SEQ` collisions. Defaults to 5. */
  maxSequenceRetries?: number;
  /** Base delay (ms) for exponential backoff. Defaults to 100. */
  sequenceRetryBaseDelayMs?: number;
}

/** Horizon result code indicating a sequence number collision. */
const TX_BAD_SEQ = "txBAD_SEQ";
=======

export interface CosignRequest {
  xdr: string;
  walletAddress: string;
  /** Originating IP address, used for geo-IP anomaly detection. */
  ipAddress?: string;
  /** Optional pre-resolved geo location for the request. */
  geo?: { country?: string; latitude?: number; longitude?: number };
}

export interface CosignResult {
  signedXdr: string;
  approved: boolean;
  reason?: string;
  code?: string;
  rulesEvaluated?: string[];
}

export interface BatchCosignItemResult {
  index: number;
  signedXdr?: string;
  approved: boolean;
  reason?: string;
  code?: string;
  rulesEvaluated?: string[];
}

export interface BatchCosignResult {
  approved: boolean;
  results: BatchCosignItemResult[];
}

export class CosignerService {
  private client: StellarClient;
  private signer: Signer;
  private policyEngine: PolicyEngine;
  private enforceTimeBounds: boolean;
  private maxValidityWindowSeconds?: number;
  private webhookDispatcher?: WebhookDispatcher;
  private fraudDetector?: FraudDetector;
  private sequenceAllocator?: SequenceAllocator;
  private maxSequenceRetries: number;
  private sequenceRetryBaseDelayMs: number;

  constructor(opts: CosignerOpts) {
    this.client = opts.client;
    this.signer = opts.signer;
    this.policyEngine = opts.policyEngine;
    this.enforceTimeBounds = opts.enforceTimeBounds ?? false;
    this.maxValidityWindowSeconds = opts.maxValidityWindowSeconds;
    this.webhookDispatcher = opts.webhookDispatcher;
    this.fraudDetector = opts.fraudDetector;
    this.sequenceAllocator = opts.sequenceAllocator;
    this.maxSequenceRetries = opts.maxSequenceRetries ?? 5;
    this.sequenceRetryBaseDelayMs = opts.sequenceRetryBaseDelayMs ?? 100;
  }

  get publicKey(): string {
    return this.signer.publicKey();
  }

  async cosign(request: CosignRequest): Promise<CosignResult> {
    return trackOperation(() => this.cosignInternal(request));
  }

  private async cosignInternal(request: CosignRequest): Promise<CosignResult> {
    const parsed = TransactionBuilder.fromXDR(
      request.xdr,
      this.client.networkPassphrase
    );
    const tx = parsed instanceof Transaction ? parsed : null;

    if (!tx) {
      return {
        signedXdr: "",
        approved: false,
        reason:
          "Fee-bump transactions are not accepted for co-signing. Please submit a regular transaction.",
      };
    }

    if (tx.source !== request.walletAddress) {
      return {
        signedXdr: "",
        approved: false,
        reason: "Transaction source does not match wallet address",
      };
    }

    const txHash = tx.hash();
    let hasOwnerSignature = false;
    try {
      const ownerKeypair = Keypair.fromPublicKey(request.walletAddress);
      hasOwnerSignature = tx.signatures.some((sig) => {
        try {
          return ownerKeypair.verify(txHash, sig.signature());
        } catch {
          return false;
        }
      });
    } catch {
      hasOwnerSignature = false;
    }

    if (!hasOwnerSignature) {
      return {
        signedXdr: "",
        approved: false,
        reason: "Transaction is not signed by the wallet owner",
      };
    }

    if (this.enforceTimeBounds) {
      const tbCheck = validateTimeBounds(tx, {
        maxWindowSeconds: this.maxValidityWindowSeconds,
        allowUnbounded: false,
      });
      if (!tbCheck.valid) {
        return {
          signedXdr: "",
          approved: false,
          reason: tbCheck.reason ?? "Timebounds validation failed",
        };
      }
    }

    if (this.fraudDetector) {
      const fraudResult = await this.fraudDetector.score({
        walletAddress: request.walletAddress,
        transaction: tx,
        ipAddress: request.ipAddress,
        geo: request.geo,
      });

      if (fraudResult.rejected) {
        if (this.webhookDispatcher) {
          this.webhookDispatcher
            .dispatch("fraud.detected", {
              walletAddress: request.walletAddress,
              reason: fraudResult.reason,
              code: fraudResult.code,
              riskScore: fraudResult.riskScore,
              txHash: txHash.toString("hex"),
            })
            .catch(() => {});
        }

        return {
          signedXdr: "",
          approved: false,
          reason: fraudResult.reason,
          code: fraudResult.code,
        };
      }
    }

    const policyResult = await this.policyEngine.evaluateWithAudit({
      walletAddress: request.walletAddress,
      transaction: tx,
    });

    if (!policyResult.approved) {
      if (this.webhookDispatcher) {
        this.webhookDispatcher
          .dispatch("policy.violated", {
            walletAddress: request.walletAddress,
            reason: policyResult.reason,
            txHash: txHash.toString("hex"),
          })
          .catch(() => {});
      }

      return {
        signedXdr: "",
        approved: false,
        reason: policyResult.reason,
        rulesEvaluated: policyResult.rulesEvaluated,
      };
    }

    // Reserve a sequence number for the sponsor account when the transaction
    // is sourced from the sponsor (i.e. the co-signer is the fee sponsor).
    await this.reserveSequenceIfNeeded(tx);

    // Sign using the abstracted Signer (KMS or env-keypair).
    const signature = await this.signer.sign(txHash);

    // Attach the signature to the transaction envelope using the decorated hint
    // format that Stellar expects: last 4 bytes of the raw public key.
    const rawPublicKey = Keypair.fromPublicKey(
      this.signer.publicKey()
    ).rawPublicKey();
    const hint = rawPublicKey.slice(-4);

    tx.signatures.push(
      new xdr.DecoratedSignature({
        hint,
        signature: Buffer.from(signature),
      })
    );

    if (this.webhookDispatcher) {
      this.webhookDispatcher
        .dispatch("transaction.cosigned", {
          walletAddress: request.walletAddress,
          txHash: txHash.toString("hex"),
        })
        .catch(() => {});
    }

    return {
      signedXdr: tx.toXDR(),
      approved: true,
      rulesEvaluated: policyResult.rulesEvaluated,
    };
  }

  /**
   * Reserves a sequence number from the distributed allocator when the
   * transaction's source is the sponsor account. No-op when no allocator is
   * configured or the transaction is sourced from the wallet.
   */
  private async reserveSequenceIfNeeded(tx: Transaction): Promise<void> {
    if (!this.sequenceAllocator) {
      return;
    }
    if (tx.source !== this.signer.publicKey()) {
      return;
    }
    const reserved = await this.sequenceAllocator.reserve(tx.source);
    tx.sequence = reserved.sequence.toString();
  }

  /**
   * Submits a signed transaction XDR to Horizon, retrying with exponential
   * backoff when Horizon reports a `txBAD_SEQ` sequence collision. On each
   * collision a fresh sequence number is reserved (when an allocator is
   * configured) and the transaction is re-signed before retrying.
   */
  async submitWithSequenceRetry(
    signedXdr: string,
    resign?: (tx: Transaction) => Promise<string>
  ): Promise<{ hash: string; status: string }> {
    let currentXdr = signedXdr;
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await this.client.submitTransaction(currentXdr);
      } catch (err) {
        const isSeqCollision = this.isSequenceCollision(err);
        if (!isSeqCollision || attempt >= this.maxSequenceRetries) {
          throw err;
        }

        attempt += 1;
        const delay = this.sequenceRetryBaseDelayMs * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));

        if (resign) {
          const parsed = TransactionBuilder.fromXDR(
            currentXdr,
            this.client.networkPassphrase
          );
          if (parsed instanceof Transaction) {
            await this.reserveSequenceIfNeeded(parsed);
            currentXdr = await resign(parsed);
          }
        }
      }
    }
  }

  private isSequenceCollision(err: unknown): boolean {
    if (!err || typeof err !== "object") {
      return false;
    }
    const anyErr = err as {
      message?: string;
      response?: { data?: { extras?: { result_codes?: { transaction?: string } } } };
    };
    const txCode = anyErr.response?.data?.extras?.result_codes?.transaction;
    if (txCode === TX_BAD_SEQ) {
      return true;
    }
    return typeof anyErr.message === "string" && anyErr.message.includes(TX_BAD_SEQ);
  }

  /**
   * Co-signs a batch of transactions. Each item is validated and evaluated
   * independently; the signing step is performed atomically after all
   * evaluations complete (all-or-nothing signing).
   */
  async cosignBatch(requests: CosignRequest[]): Promise<BatchCosignResult> {
    const results: BatchCosignItemResult[] = [];
    const signable: Array<{ index: number; tx: Transaction; txHash: Buffer }> =
      [];

    for (let index = 0; index < requests.length; index++) {
      const request = requests[index];
      const outcome = await this.evaluateForBatch(request);

      if (!outcome.approved) {
        results.push({
          index,
          approved: false,
          reason: outcome.reason,
          code: outcome.code,
          rulesEvaluated: outcome.rulesEvaluated,
        });
        continue;
      }

      results.push({
        index,
        approved: true,
        rulesEvaluated: outcome.rulesEvaluated,
      });
      signable.push({
        index,
        tx: outcome.tx,
        txHash: outcome.txHash,
      });
    }

    // Atomic signing step: only reached once every item has been evaluated.
    for (const item of signable) {
      try {
        await this.reserveSequenceIfNeeded(item.tx);
        const signature = await this.signer.sign(item.txHash);
        const rawPublicKey = Keypair.fromPublicKey(
          this.signer.publicKey()
        ).rawPublicKey();
        const hint = rawPublicKey.slice(-4);

        item.tx.signatures.push(
          new xdr.DecoratedSignature({
            hint,
            signature: Buffer.from(signature),
          })
        );

        const entry = results[item.index];
        entry.signedXdr = item.tx.toXDR();

        if (this.webhookDispatcher) {
          this.webhookDispatcher
            .dispatch("transaction.cosigned", {
              walletAddress: item.tx.source,
              txHash: item.txHash.toString("hex"),
            })
            .catch(() => {});
        }
      } catch (err) {
        const entry = results[item.index];
        entry.approved = false;
        entry.signedXdr = undefined;
        entry.reason =
          err instanceof Error ? err.message : "Signing failed for batch item";
      }
    }

    return {
      approved: results.every((r) => r.approved),
      results,
    };
  }

  private async evaluateForBatch(
    request: CosignRequest
  ): Promise<
    | { approved: true; tx: Transaction; txHash: Buffer; rulesEvaluated: string[] }
    | { approved: false; reason?: string; code?: string; rulesEvaluated?: string[] }
  > {
    let parsed;
    try {
      parsed = TransactionBuilder.fromXDR(
        request.xdr,
        this.client.networkPassphrase
      );
    } catch {
      return { approved: false, reason: "Invalid transaction XDR" };
    }

    const tx = parsed instanceof Transaction ? parsed : null;
    if (!tx) {
      return {
        approved: false,
        reason:
          "Fee-bump transactions are not accepted for co-signing. Please submit a regular transaction.",
      };
    }

    if (tx.source !== request.walletAddress) {
      return {
        approved: false,
        reason: "Transaction source does not match wallet address",
      };
    }

    const txHash = tx.hash();
    let hasOwnerSignature = false;
    try {
      const ownerKeypair = Keypair.fromPublicKey(request.walletAddress);
      hasOwnerSignature = tx.signatures.some((sig) => {
        try {
          return ownerKeypair.verify(txHash, sig.signature());
        } catch {
          return false;
        }
      });
    } catch {
      hasOwnerSignature = false;
    }

    if (!hasOwnerSignature) {
      return {
        approved: false,
        reason: "Transaction is not signed by the wallet owner",
      };
    }

    if (this.enforceTimeBounds) {
      const tbCheck = validateTimeBounds(tx, {
        maxWindowSeconds: this.maxValidityWindowSeconds,
        allowUnbounded: false,
      });
      if (!tbCheck.valid) {
        return {
          approved: false,
          reason: tbCheck.reason ?? "Timebounds validation failed",
        };
      }
    }

    if (this.fraudDetector) {
      const fraudResult = await this.fraudDetector.score({
        walletAddress: request.walletAddress,
        transaction: tx,
        ipAddress: request.ipAddress,
        geo: request.geo,
      });

      if (fraudResult.rejected) {
        if (this.webhookDispatcher) {
          this.webhookDispatcher
            .dispatch("fraud.detected", {
              walletAddress: request.walletAddress,
              reason: fraudResult.reason,
              code: fraudResult.code,
              riskScore: fraudResult.riskScore,
              txHash: txHash.toString("hex"),
            })
            .catch(() => {});
        }

        return {
          approved: false,
          reason: fraudResult.reason,
          code: fraudResult.code,
        };
      }
    }

    const policyResult = await this.policyEngine.evaluateWithAudit({
      walletAddress: request.walletAddress,
      transaction: tx,
    });

    if (!policyResult.approved) {
      if (this.webhookDispatcher) {
        this.webhookDispatcher
          .dispatch("policy.violated", {
            walletAddress: request.walletAddress,
            reason: policyResult.reason,
            txHash: txHash.toString("hex"),
          })
          .catch(() => {});
      }

      return {
        approved: false,
        reason: policyResult.reason,
        rulesEvaluated: policyResult.rulesEvaluated,
      };
    }

    return { approved: true, tx, txHash, rulesEvaluated: policyResult.rulesEvaluated };
  }
}
