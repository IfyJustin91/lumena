import { TransactionBuilder, Transaction, Keypair, xdr } from "@stellar/stellar-sdk";
import type { Signer } from "@lumen/types";
import type { StellarClient } from "@lumen/core";
import type { WebhookDispatcher } from "../webhook/dispatcher.js";
import { trackOperation } from "../lifecycle.js";
import type { SequenceAllocator } from "./sequence-allocator.js";

export interface FeeSponsorOpts {
  client: StellarClient;
  /** Production: use an AwsKmsSigner. Dev/testnet: use an EnvSigner. */
  signer: Signer;
  baseFee?: string;
  webhookDispatcher?: WebhookDispatcher;
  /**
   * Optional distributed sequence allocator. When provided, each fee-bump
   * transaction reserves a distinct sequence number so concurrent submissions
   * do not collide on the sponsor account sequence.
   */
  sequenceAllocator?: SequenceAllocator;
  /** Max attempts for the exponential-backoff retry on txBAD_SEQ. Default 5. */
  maxSubmitAttempts?: number;
  /** Base delay (ms) for exponential backoff. Default 100. */
  retryBaseDelayMs?: number;
}

export class FeeSponsorService {
  private client: StellarClient;
  private signer: Signer;
  private baseFee: string;
  private webhookDispatcher?: WebhookDispatcher;
  private sequenceAllocator?: SequenceAllocator;
  private maxSubmitAttempts: number;
  private retryBaseDelayMs: number;

  constructor(opts: FeeSponsorOpts) {
    this.client = opts.client;
    this.signer = opts.signer;
    this.baseFee = opts.baseFee ?? "1000000";
    this.webhookDispatcher = opts.webhookDispatcher;
    this.sequenceAllocator = opts.sequenceAllocator;
    this.maxSubmitAttempts = opts.maxSubmitAttempts ?? 5;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 100;
  }

  get publicKey(): string {
    return this.signer.publicKey();
  }

  async wrapFeeBump(innerTxXdr: string, sequence?: string): Promise<string> {
    return trackOperation("fee-bump:wrap", async () => {
      const parsed = TransactionBuilder.fromXDR(innerTxXdr, this.client.networkPassphrase);
      const innerTx = parsed instanceof Transaction ? parsed : null;
      if (!innerTx) {
        throw new Error("Expected a regular transaction, not a fee-bump");
      }

      // Build the fee-bump envelope.  buildFeeBumpTransaction derives the
      // fee-source account from a Keypair; we create a public-key-only Keypair
      // so the private key is never needed here.  Signing uses our Signer
      // abstraction so the private key stays in KMS / never in memory.
      const feeSourceKeypair = Keypair.fromPublicKey(this.signer.publicKey());
      const feeBump = TransactionBuilder.buildFeeBumpTransaction(
        feeSourceKeypair,
        this.baseFee,
        innerTx,
        this.client.networkPassphrase,
      );

      // Apply the reserved sequence number (if any) so concurrent fee-bumps
      // from the same sponsor account don't collide.
      if (sequence !== undefined) {
        feeBump.sequence = sequence;
      }

      // Sign via the abstracted Signer.
      const txHash = feeBump.hash();
      const signature = await this.signer.sign(txHash);
      const hint = feeSourceKeypair.rawPublicKey().slice(-4);

      feeBump.signatures.push(
        new xdr.DecoratedSignature({
          hint,
          signature: Buffer.from(signature),
        }),
      );

      return feeBump.toXDR();
    });
  }

  private isBadSeqError(err: unknown): boolean {
    const anyErr = err as { response?: { data?: { extras?: { result_codes?: { transaction?: string } } } }; message?: string };
    const code = anyErr?.response?.data?.extras?.result_codes?.transaction;
    if (code === "txBAD_SEQ") return true;
    const msg = typeof anyErr?.message === "string" ? anyErr.message : "";
    return msg.includes("txBAD_SEQ");
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async submit(innerTxXdr: string): Promise<{ hash: string; feeBumpHash: string }> {
    return trackOperation("fee-bump:submit", async () => {
      let lastError: unknown;
      let reservedSequence: string | undefined;

      for (let attempt = 0; attempt < this.maxSubmitAttempts; attempt++) {
        // Reserve a fresh sequence number for each attempt when an allocator
        // is configured. On retry after txBAD_SEQ we re-reserve.
        if (this.sequenceAllocator) {
          reservedSequence = await this.sequenceAllocator.reserve(this.signer.publicKey());
        }

        const feeBumpXdr = await this.wrapFeeBump(innerTxXdr, reservedSequence);
        const parsed = TransactionBuilder.fromXDR(feeBumpXdr, this.client.networkPassphrase);

        let result: Awaited<ReturnType<StellarClient["horizon"]["submitTransaction"]>>;
        try {
          result = await this.client.horizon.submitTransaction(parsed);
        } catch (err) {
          if (this.isBadSeqError(err) && attempt < this.maxSubmitAttempts - 1) {
            lastError = err;
            // Roll back the reservation so the sequence can be reused.
            if (this.sequenceAllocator && reservedSequence !== undefined) {
              await this.sequenceAllocator
                .rollback(this.signer.publicKey(), reservedSequence)
                .catch(() => {});
            }
            reservedSequence = undefined;
            const backoff = this.retryBaseDelayMs * 2 ** attempt;
            await this.delay(backoff);
            continue;
          }
          throw err;
        }

        if (!result.successful) {
          throw new Error(`Fee-bump submission failed: ${result.hash}`);
        }

      if (this.webhookDispatcher) {
        this.webhookDispatcher
          .dispatch("transaction.fee_bump.submitted", {
            feeSource: this.signer.publicKey(),
            hash: result.hash,
            feeBumpHash: result.hash,
          })
          .catch(() => {});

        this.webhookDispatcher
          .dispatch("transaction.sponsored", {
            feeSource: this.signer.publicKey(),
            hash: result.hash,
          })
          .catch(() => {});
      }

        return { hash: result.hash, feeBumpHash: result.hash };
      }

      throw lastError ?? new Error("Fee-bump submission failed after retries");
    });
  }
}
