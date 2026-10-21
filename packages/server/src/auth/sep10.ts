import express, { Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Transaction,
  Account,
  Operation,
  BASE_FEE,
  Memo,
} from '@stellar/stellar-sdk';

/**
 * SEP-10 Web Authentication Protocol implementation.
 *
 * Provides:
 *  - GET  /auth/challenge?account=<publicKey>  -> server-signed challenge transaction envelope
 *  - POST /auth/token                          -> validates client signature and issues a 24h JWT
 */

const JWT_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const CHALLENGE_TTL_SECONDS = 5 * 60; // 5 minutes
const NONCE_BYTES = 48;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getServerKeypair(): Keypair {
  const secret = process.env.LUMEN_SERVER_SECRET;
  if (!secret) {
    throw new Error('LUMEN_SERVER_SECRET environment variable is not set');
  }
  return Keypair.fromSecret(secret);
}

function getNetworkPassphrase(): string {
  const passphrase = process.env.LUMEN_NETWORK_PASSPHRASE;
  if (passphrase) {
    return passphrase;
  }
  const network = (process.env.LUMEN_NETWORK || 'testnet').toLowerCase();
  switch (network) {
    case 'public':
    case 'mainnet':
      return Networks.PUBLIC;
    case 'futurenet':
      return Networks.FUTURENET;
    case 'testnet':
    default:
      return Networks.TESTNET;
  }
}

function getJwtSecret(): string {
  const secret = process.env.LUMEN_JWT_SECRET;
  if (!secret) {
    throw new Error('LUMEN_JWT_SECRET environment variable is not set');
  }
  return secret;
}

// ---------------------------------------------------------------------------
// Nonce replay protection
// ---------------------------------------------------------------------------

/**
 * In-memory nonce store with TTL-based expiry. If a Redis client is provided
 * via `setNonceStore`, it will be used instead. The interface is intentionally
 * minimal so it can be swapped for a Redis-backed implementation.
 */
export interface NonceStore {
  has(nonce: string): Promise<boolean> | boolean;
  add(nonce: string, ttlSeconds: number): Promise<void> | void;
}

class InMemoryNonceStore implements NonceStore {
  private readonly entries = new Map<string, number>();

  private prune(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(nonce);
      }
    }
  }

  has(nonce: string): boolean {
    this.prune();
    const expiresAt = this.entries.get(nonce);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= Date.now()) {
      this.entries.delete(nonce);
      return false;
    }
    return true;
  }

  add(nonce: string, ttlSeconds: number): void {
    this.prune();
    this.entries.set(nonce, Date.now() + ttlSeconds * 1000);
  }
}

let nonceStore: NonceStore = new InMemoryNonceStore();

/**
 * Allows swapping the nonce store (e.g. for a Redis-backed implementation).
 */
export function setNonceStore(store: NonceStore): void {
  nonceStore = store;
}

// ---------------------------------------------------------------------------
// Challenge building
// ---------------------------------------------------------------------------

export interface ChallengeResult {
  transaction: string;
  network_passphrase: string;
}

/**
 * Builds a SEP-10 challenge transaction for the given account.
 *
 * The transaction:
 *  - is sourced from the server account,
 *  - contains a single ManageData operation with a random nonce,
 *  - has timebounds valid for CHALLENGE_TTL_SECONDS,
 *  - is signed by the server keypair.
 */
export function buildChallenge(account: string): ChallengeResult {
  if (!account || typeof account !== 'string') {
    throw new Error('account is required');
  }

  // Validate the account is a valid Stellar public key.
  Keypair.fromPublicKey(account);

  const serverKeypair = getServerKeypair();
  const networkPassphrase = getNetworkPassphrase();
  const now = Math.floor(Date.now() / 1000);

  const nonce = crypto.randomBytes(NONCE_BYTES).toString('base64');

  const sourceAccount = new Account(serverKeypair.publicKey(), '-1');

  const transaction = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
    timebounds: {
      minTime: now,
      maxTime: now + CHALLENGE_TTL_SECONDS,
    },
  })
    .addOperation(
      Operation.manageData({
        name: 'lumen auth',
        value: nonce,
        source: account,
      }),
    )
    .addMemo(Memo.text('lumen-sep10'))
    .build();

  transaction.sign(serverKeypair);

  return {
    transaction: transaction.toEnvelope().toXDR('base64'),
    network_passphrase: networkPassphrase,
  };
}

// ---------------------------------------------------------------------------
// Challenge verification
// ---------------------------------------------------------------------------

export interface VerifyResult {
  account: string;
  nonce: string;
}

/**
 * Verifies a client-signed challenge transaction.
 *
 * Checks:
 *  - the envelope parses,
 *  - the transaction is signed by the server,
 *  - the transaction is signed by the client account,
 *  - the timebounds are currently valid,
 *  - the nonce has not been replayed.
 *
 * On success, the nonce is recorded to prevent replay and the client account
 * is returned.
 */
export async function verifyChallenge(signedXdr: string): Promise<VerifyResult> {
  if (!signedXdr || typeof signedXdr !== 'string') {
    throw new Error('transaction is required');
  }

  const serverKeypair = getServerKeypair();
  const networkPassphrase = getNetworkPassphrase();

  let transaction: Transaction;
  try {
    transaction = new Transaction(signedXdr, networkPassphrase);
  } catch (err) {
    throw new Error('invalid transaction envelope');
  }

  // The transaction must be sourced from the server account.
  if (transaction.source !== serverKeypair.publicKey()) {
    throw new Error('transaction source must be the server account');
  }

  // Validate timebounds.
  const now = Math.floor(Date.now() / 1000);
  const timebounds = transaction.timeBounds;
  if (!timebounds) {
    throw new Error('transaction is missing timebounds');
  }
  const minTime = Number(timebounds.minTime);
  const maxTime = Number(timebounds.maxTime);
  if (now < minTime) {
    throw new Error('transaction is not yet valid');
  }
  if (now > maxTime) {
    throw new Error('transaction has expired');
  }

  // Validate the operation structure: exactly one ManageData operation.
  const operations = transaction.operations;
  if (operations.length !== 1) {
    throw new Error('transaction must contain exactly one operation');
  }
  const op = operations[0];
  if (op.type !== 'manageData') {
    throw new Error('transaction must contain a manageData operation');
  }
  if (op.name !== 'lumen auth') {
    throw new Error('invalid manageData operation name');
  }
  if (!op.value) {
    throw new Error('manageData operation is missing a nonce');
  }
  const clientAccount = op.source;
  if (!clientAccount) {
    throw new Error('manageData operation is missing a source account');
  }

  // Validate signatures.
  const serverSigned = transaction.signatures.some((sig) => {
    try {
      return serverKeypair.verify(
        transaction.hash(),
        sig.signature(),
      );
    } catch {
      return false;
    }
  });
  if (!serverSigned) {
    throw new Error('transaction is not signed by the server');
  }

  const clientKeypair = Keypair.fromPublicKey(clientAccount);
  const clientSigned = transaction.signatures.some((sig) => {
    try {
      return clientKeypair.verify(
        transaction.hash(),
        sig.signature(),
      );
    } catch {
      return false;
    }
  });
  if (!clientSigned) {
    throw new Error('transaction is not signed by the client account');
  }

  // Nonce replay protection.
  const nonce = Buffer.from(op.value).toString('base64');
  const replayed = await nonceStore.has(nonce);
  if (replayed) {
    throw new Error('challenge has already been used');
  }
  await nonceStore.add(nonce, CHALLENGE_TTL_SECONDS);

  return { account: clientAccount, nonce };
}

// ---------------------------------------------------------------------------
// Token issuance
// ---------------------------------------------------------------------------

export interface TokenResult {
  token: string;
  expires_in: number;
}

/**
 * Issues a 24-hour HS256 JWT for the given account.
 */
export function issueToken(account: string): TokenResult {
  if (!account || typeof account !== 'string') {
    throw new Error('account is required');
  }

  const token = jwt.sign(
    {
      sub: account,
      iss: 'lumen',
      iat: Math.floor(Date.now() / 1000),
    },
    getJwtSecret(),
    {
      algorithm: 'HS256',
      expiresIn: JWT_TTL_SECONDS,
    },
  );

  return { token, expires_in: JWT_TTL_SECONDS };
}

// ---------------------------------------------------------------------------
// Express router
// ---------------------------------------------------------------------------

export const authRouter: Router = express.Router();

authRouter.get('/auth/challenge', (req: Request, res: Response) => {
  const account = req.query.account;
  if (!account || typeof account !== 'string') {
    res.status(400).json({ error: 'account query parameter is required' });
    return;
  }

  try {
    const challenge = buildChallenge(account);
    res.status(200).json({
      transaction: challenge.transaction,
      network_passphrase: challenge.network_passphrase,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to build challenge';
    res.status(400).json({ error: message });
  }
});

authRouter.post('/auth/token', async (req: Request, res: Response) => {
  const transaction = req.body?.transaction;
  if (!transaction || typeof transaction !== 'string') {
    res.status(400).json({ error: 'transaction is required' });
    return;
  }

  try {
    const { account } = await verifyChallenge(transaction);
    const { token, expires_in } = issueToken(account);
    res.status(200).json({ token, expires_in });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'authentication failed';
    res.status(401).json({ error: message });
  }
});

export default authRouter;