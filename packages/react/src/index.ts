"use client";

export { LumenProvider, useLumen, LumenServerProvider } from "./context.js";
export type {
  LumenContextValue,
  LumenProviderProps,
  LumenServerProviderProps,
  LumenNetwork,
} from "./context.js";

export { useIsMounted } from "./hooks/use-is-mounted.js";

export { useWallet } from "./use-wallet.js";
export type { UseWalletResult } from "./use-wallet.js";

export { useCreateWallet } from "./use-create-wallet.js";
export type { CreateWalletResult, UseCreateWalletResult } from "./use-create-wallet.js";

export { useBalance } from "./use-balance.js";
export type { UseBalanceResult } from "./use-balance.js";

export { useSendPayment } from "./use-send-payment.js";
export type {
  SendPaymentParams,
  SendPaymentResult,
  UseSendPaymentResult,
} from "./use-send-payment.js";

// #262 — Gasless payments with optimistic balance updates and auto-rollback
export { useGaslessTransaction } from "./use-gasless-transaction.js";
export type {
  GaslessTransactionParams,
  GaslessTransactionResult,
  UseGaslessTransactionResult,
} from "./use-gasless-transaction.js";

export { usePolicy } from "./use-policy.js";
export type { UsePolicyResult, WalletPolicy } from "./use-policy.js";

export { useSponsorStatus } from "./use-sponsor-status.js";
export type {
  SponsorStatus,
  UseSponsorStatusOptions,
  UseSponsorStatusResult,
} from "./use-sponsor-status.js";

export { useInvokeContract } from "./use-invoke-contract.js";
export type {
  InvokeContractParams,
  InvokeContractResult,
  UseInvokeContractResult,
} from "./use-invoke-contract.js";

export { useSorobanContract } from "./use-soroban-contract.js";
export type {
  SorobanContractMethod,
  SorobanContractSpec,
  SorobanContractSpecDefinition,
  SorobanSimulation,
  UseSorobanContractOptions,
  UseSorobanContractResult,
} from "./use-soroban-contract.js";

export { useTrustline } from "./use-trustline.js";
export type { UseTrustlineResult } from "./use-trustline.js";

export { useTransactionHistory } from "./use-transaction-history.js";
export type { Transaction, UseTransactionHistoryResult } from "./use-transaction-history.js";

// #264 — SEP-41 token allowance query and approval hooks
export { useTokenAllowance, useApproveToken } from "./use-token-allowance.js";
export type {
  TokenAllowance,
  UseTokenAllowanceResult,
  ApproveTokenResult,
  UseApproveTokenResult,
} from "./use-token-allowance.js";

export { useSessionKey } from "./use-session-key.js";
export type { SessionKeyState } from "./use-session-key.js";

// #269 — Session key manager with TTL countdown, scoped limits, and revocation
export { useSessionKeyManager } from "./use-session-key-manager.js";
export type {
  ManagedSessionKey,
  UseSessionKeyManagerOptions,
  UseSessionKeyManagerResult,
} from "./use-session-key-manager.js";

// #279 — Multi-device co-signing sessions
export { useMultiSigApproval } from "./use-multisig-approval.js";
export type {
  MultiSigSession,
  MultiSigSessionStatus,
  UseMultiSigApprovalOptions,
  UseMultiSigApprovalResult,
} from "./use-multisig-approval.js";

// #273 — Network health monitor with RPC latency ping and failover alerting
export { useNetworkHealth } from "./use-network-health.js";
export type {
  NetworkHealthStatus,
  UseNetworkHealthOptions,
  UseNetworkHealthResult,
} from "./use-network-health.js";

// #281 — i18n framework
export { useTranslation, resolveTranslations, translations } from "./i18n/index.js";
export type { LumenLocale, LumenTranslations, LumenI18nContextValue } from "./i18n/index.js";

// #268 — Design tokens and dark/light theme provider
export { LumenThemeProvider, useLumenTheme } from "./theme/index.js";
export type {
  LumenThemeMode,
  LumenThemeTokens,
  LumenThemeContextValue,
  LumenThemeProviderProps,
} from "./theme/index.js";

export { LumenBalance } from "./components/LumenBalance.js";
export type { LumenBalanceProps } from "./components/LumenBalance.js";

export { LumenWalletCard } from "./components/LumenWalletCard.js";
export type { LumenWalletCardProps } from "./components/LumenWalletCard.js";

export { LumenConnectModal } from "./components/LumenConnectModal.js";
export type {
  ConnectWalletResult,
  LumenConnectModalProps,
  LumenConnectModalTab,
  LumenConnectModalTheme,
} from "./components/LumenConnectModal.js";

// #258 — Multi-network context switcher and network status bar
export { LumenNetworkBar } from "./components/LumenNetworkBar.js";
export type {
  LumenNetworkBarProps,
  LumenNetworkLatencyStatus,
} from "./components/LumenNetworkBar.js";

export { LumenSwapWidget } from "./components/LumenSwapWidget.js";
export type { LumenSwapWidgetProps } from "./components/LumenSwapWidget.js";
// #266 — QR scanner with camera access, flash toggle, and URI parsing
export { LumenQrScanner } from "./components/LumenQrScanner.js";
export type {
  LumenQrScannerProps,
  LumenQrScanResult,
  LumenQrScanResultType,
} from "./components/LumenQrScanner.js";

// #276 — Error boundary with sanitized diagnostics export
export { LumenErrorBoundary } from "./components/LumenErrorBoundary.js";
export type {
  LumenErrorBoundaryProps,
  LumenErrorDiagnostics,
} from "./components/LumenErrorBoundary.js";

// #271 — Encrypted client-side wallet state persistence
export {
  EncryptedIndexedDBStorage,
  createEncryptedStorage,
  deriveStorageKey,
  purgeExpiredRecords,
} from "./storage/indexeddb-storage.js";
export type {
  EncryptedStorageOptions,
  StorageRecord,
  StoredWalletState,
} from "./storage/indexeddb-storage.js";
