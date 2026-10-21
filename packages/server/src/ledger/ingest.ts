import type { StellarClient } from "@lumen/core";
import { logger } from "../logger.js";

export type LedgerTransactionStatus = "SUCCESS" | "FAILED";

export interface LedgerTransactionUpdate {
  hash: string;
  status: LedgerTransactionStatus;
  fee: string;
  ledger: number;
  walletAddress: string;
}

type HorizonStream = { close: () => void } | (() => void);

export interface LedgerIngestOpts {
  client: StellarClient;
  listWalletAddresses: () => Promise<string[]>;
  updateTransaction: (update: LedgerTransactionUpdate) => Promise<void>;
  onUpdate?: (update: LedgerTransactionUpdate) => void;
  refreshIntervalMs?: number;
}

/** Streams transactions for registered wallets and reconciles persisted records. */
export class LedgerIngestionWorker {
  private readonly opts: LedgerIngestOpts;
  private readonly streams = new Map<string, () => void>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(opts: LedgerIngestOpts) {
    this.opts = opts;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refreshWalletStreams();
    this.refreshTimer = setInterval(
      () => void this.refreshWalletStreams(),
      this.opts.refreshIntervalMs ?? 60_000,
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    for (const close of this.streams.values()) close();
    this.streams.clear();
  }

  private async refreshWalletStreams(): Promise<void> {
    if (this.stopped) return;
    try {
      const addresses = await this.opts.listWalletAddresses();
      for (const address of addresses) {
        if (this.stopped || this.streams.has(address)) continue;
        let closeStream: (() => void) | undefined;
        const stream = this.opts.client.horizon
          .transactions()
          .forAccount(address)
          .cursor("now")
          .stream({
            onmessage: (record) => {
              const update: LedgerTransactionUpdate = {
                hash: record.hash,
                status: record.successful ? "SUCCESS" : "FAILED",
                fee: record.fee_charged,
                ledger: record.ledger,
                walletAddress: address,
              };
              void this.opts
                .updateTransaction(update)
                .then(() => this.opts.onUpdate?.(update))
                .catch((error: unknown) =>
                  logger.error({ error, hash: record.hash }, "Failed to reconcile ledger transaction"),
                );
            },
            onerror: (error) => {
              logger.error({ error, address }, "Horizon transaction stream failed");
              if (closeStream && this.streams.get(address) === closeStream) {
                this.streams.delete(address);
                closeStream();
              }
            },
          }) as unknown as HorizonStream;
        closeStream = typeof stream === "function" ? stream : () => stream.close();
        this.streams.set(address, closeStream);
      }
    } catch (error) {
      logger.error({ error }, "Failed to refresh registered wallet streams");
    }
  }
}