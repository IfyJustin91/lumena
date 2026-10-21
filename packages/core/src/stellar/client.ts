import { Horizon, rpc as sorobanRpc, Networks } from "@stellar/stellar-sdk";
import type { StellarConfig, StellarNetwork } from "@lumen/types";
import { SequenceNumberCache } from "./sequence-number-cache";

type HorizonServer = InstanceType<typeof Horizon.Server>;
type RpcServer = InstanceType<typeof sorobanRpc.Server>;

const NETWORKS: Record<StellarNetwork, StellarConfig> = {
  testnet: {
    network: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
  },
  mainnet: {
    network: "mainnet",
    horizonUrl: "https://horizon.stellar.org",
    rpcUrl: "https://soroban-mainnet.stellar.org",
    networkPassphrase: Networks.PUBLIC,
  },
  local: {
    network: "local",
    horizonUrl: "http://localhost:8000",
    rpcUrl: "http://localhost:8000/rpc",
    networkPassphrase: Networks.STANDALONE,
  },
  futurenet: {
    network: "futurenet",
    horizonUrl: "https://horizon-futurenet.stellar.org",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    networkPassphrase: Networks.FUTURENET,
  },
};

export interface StellarClientOpts {
  network?: StellarNetwork;
  horizonUrl?: string;
  rpcUrl?: string;
  /** Opt-in sequence number cache. Pass `true` for defaults or options to tune the TTL. */
  sequenceCache?: boolean | { ttlMs?: number };
}

export class StellarClient {
  readonly config: StellarConfig;
  readonly horizon: HorizonServer;
  readonly rpc: RpcServer;
  readonly sequenceCache?: SequenceNumberCache;

  constructor(opts: StellarClientOpts = {}) {
    const network = opts.network ?? "testnet";
    const defaults = NETWORKS[network];

    this.config = {
      ...defaults,
      horizonUrl: opts.horizonUrl ?? defaults.horizonUrl,
      rpcUrl: opts.rpcUrl ?? defaults.rpcUrl,
    };

    this.horizon = new Horizon.Server(this.config.horizonUrl, {
      allowHttp: this.config.network === "local" || this.config.horizonUrl.startsWith("http://"),
    });
    this.rpc = new sorobanRpc.Server(this.config.rpcUrl, { allowHttp: this.config.network === "local" });

    if (opts.sequenceCache) {
      this.sequenceCache = new SequenceNumberCache(
        typeof opts.sequenceCache === "object" ? opts.sequenceCache : {},
      );
    }
  }

  get networkPassphrase(): string {
    return this.config.networkPassphrase;
  }

  /**
   * Loads an account's current sequence number, using the sequence cache when
   * it is enabled and populated. Falls back to Horizon on a cache miss.
   */
  async loadSequenceNumber(accountId: string): Promise<string> {
    const cached = this.sequenceCache?.get(accountId);
    if (cached !== null && cached !== undefined) return cached;

    const account = await this.horizon.loadAccount(accountId);
    const sequence = account.sequenceNumber();
    this.sequenceCache?.set(accountId, sequence);
    return sequence;
  }

  /**
   * Records that a transaction for the account was submitted, advancing the
   * cached sequence number locally when the cache is enabled.
   */
  recordSequenceNumber(accountId: string): void {
    this.sequenceCache?.increment(accountId);
  }
}
