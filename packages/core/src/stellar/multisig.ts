import type {
  Keypair} from "@stellar/stellar-sdk";
import {
  TransactionBuilder,
  Operation,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import type { StellarClient } from "./client.js";

export interface SetupMultisigOpts {
  client: StellarClient;
  accountKeypair: Keypair;
  coSignerPublicKey: string;
  threshold?: number;
  weight?: number;
  expiresAt?: number;
}

export interface SetupSessionKeyOpts {
  client: StellarClient;
  accountKeypair: Keypair;
  sessionPublicKey: string;
  weight?: number;
  expiresAt?: number;
}

export interface RevokeSessionKeyOpts {
  client: StellarClient;
  accountKeypair: Keypair;
  sessionPublicKey: string;
}

export interface ProposeUpgradeOpts {
  client: StellarClient;
  accountKeypair: Keypair;
  /** Address (contract or account) of the proxy contract to upgrade. */
  proxyContractId: string;
  /** Hash of the new WASM blob to migrate the proxy to. */
  newWasmHash: string;
  /** Ledger timestamp (seconds) at which the upgrade becomes executable. */
  timelockUntil: number;
  /** Optional migration entrypoint invoked after the WASM swap. */
  migrationFn?: string;
}

export interface ApproveUpgradeOpts {
  client: StellarClient;
  accountKeypair: Keypair;
  proxyContractId: string;
  /** Identifier of the pending upgrade proposal (e.g. wasm hash or proposal id). */
  proposalId: string;
}

export interface ExecuteUpgradeOpts {
  client: StellarClient;
  accountKeypair: Keypair;
  proxyContractId: string;
  proposalId: string;
  /** Current ledger timestamp (seconds); must be >= the proposal timelock. */
  currentLedgerTime: number;
  /** Timelock recorded when the proposal was created. */
  timelockUntil: number;
  migrationFn?: string;
}

export interface UpgradeInvocation {
  contractId: string;
  method: string;
  args: unknown[];
  /** Ledger timestamp (seconds) before which the invocation must not be submitted. */
  notBefore?: number;
}

export async function setupMultisig(opts: SetupMultisigOpts): Promise<{ hash: string }> {
  const {
    client,
    accountKeypair,
    coSignerPublicKey,
    threshold = 2,
    weight = 1,
  } = opts;

  const account = await client.horizon.loadAccount(accountKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: coSignerPublicKey, weight },
      })
    )
    .addOperation(
      Operation.setOptions({
        lowThreshold: threshold,
        medThreshold: threshold,
        highThreshold: threshold,
      })
    )
    .setTimeout(180)
    .build();

  tx.sign(accountKeypair);

  const result = await client.horizon.submitTransaction(tx);

  if (result.successful) {
    return { hash: result.hash };
  }

  throw new Error(`Multisig setup failed: ${result.hash}`);
}

/**
 * Builds the `propose_upgrade` invocation for the proxy contract.
 *
 * The proposal records the target WASM hash and the timelock deadline so that
 * co-signers can review it before any state migration is executed.
 */
export function buildProposeUpgradeInvocation(opts: ProposeUpgradeOpts): UpgradeInvocation {
  const { proxyContractId, newWasmHash, timelockUntil, migrationFn } = opts;

  if (!proxyContractId) {
    throw new Error("propose_upgrade requires a proxy contract id");
  }
  if (!newWasmHash) {
    throw new Error("propose_upgrade requires a new wasm hash");
  }
  if (!Number.isFinite(timelockUntil) || timelockUntil <= 0) {
    throw new Error("propose_upgrade requires a positive timelock deadline");
  }

  const args: unknown[] = [newWasmHash, timelockUntil];
  if (migrationFn) {
    args.push(migrationFn);
  }

  return {
    contractId: proxyContractId,
    method: "propose_upgrade",
    args,
  };
}

/**
 * Builds the `approve_upgrade` invocation. Each co-signer submits one approval;
 * the proxy only allows execution once the signer weight meets the threshold.
 */
export function buildApproveUpgradeInvocation(opts: ApproveUpgradeOpts): UpgradeInvocation {
  const { proxyContractId, proposalId } = opts;

  if (!proxyContractId) {
    throw new Error("approve_upgrade requires a proxy contract id");
  }
  if (!proposalId) {
    throw new Error("approve_upgrade requires a proposal id");
  }

  return {
    contractId: proxyContractId,
    method: "approve_upgrade",
    args: [proposalId],
  };
}

/**
 * Builds the `execute_upgrade` invocation, enforcing the timelock client-side
 * before the transaction is ever assembled.
 */
export function buildExecuteUpgradeInvocation(opts: ExecuteUpgradeOpts): UpgradeInvocation {
  const { proxyContractId, proposalId, currentLedgerTime, timelockUntil, migrationFn } = opts;

  if (!proxyContractId) {
    throw new Error("execute_upgrade requires a proxy contract id");
  }
  if (!proposalId) {
    throw new Error("execute_upgrade requires a proposal id");
  }
  if (!Number.isFinite(currentLedgerTime) || currentLedgerTime <= 0) {
    throw new Error("execute_upgrade requires the current ledger time");
  }
  if (currentLedgerTime < timelockUntil) {
    throw new Error(
      `Upgrade timelock not elapsed: executable at ${timelockUntil}, current ledger time ${currentLedgerTime}`
    );
  }

  const args: unknown[] = [proposalId];
  if (migrationFn) {
    args.push(migrationFn);
  }

  return {
    contractId: proxyContractId,
    method: "execute_upgrade",
    args,
    notBefore: timelockUntil,
  };
}

export async function setupSessionKey(opts: SetupSessionKeyOpts): Promise<{ hash: string; expiresAt?: number }> {
  const { client, accountKeypair, sessionPublicKey, weight = 1, expiresAt } = opts;

  const account = await client.horizon.loadAccount(accountKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: sessionPublicKey, weight },
      })
    )
    .setTimeout(180)
    .build();

  tx.sign(accountKeypair);

  const result = await client.horizon.submitTransaction(tx);

  if (result.successful) {
    return { hash: result.hash, expiresAt };
  }

  throw new Error(`Session key setup failed: ${result.hash}`);
}

export async function revokeSessionKey(opts: RevokeSessionKeyOpts): Promise<{ hash: string }> {
  const { client, accountKeypair, sessionPublicKey } = opts;

  const account = await client.horizon.loadAccount(accountKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: sessionPublicKey, weight: 0 },
      })
    )
    .setTimeout(180)
    .build();

  tx.sign(accountKeypair);

  const result = await client.horizon.submitTransaction(tx);

  if (result.successful) {
    return { hash: result.hash };
  }

  throw new Error(`Session key revocation failed: ${result.hash}`);
}

