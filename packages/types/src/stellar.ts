export type StellarNetwork = "testnet" | "mainnet" | "local" | "futurenet";

export interface SignerConfig {
  publicKey: string;
  weight: number;
}

export interface TransactionResult {
  hash: string;
  ledger: number;
  success: boolean;
  error?: string;
}

export interface StellarConfig {
  network: StellarNetwork;
  horizonUrl: string;
  rpcUrl: string;
  networkPassphrase: string;
}