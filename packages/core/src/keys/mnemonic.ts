import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@stellar/stellar-sdk';

/**
 * Default BIP-39 strength (128 bits => 12 words).
 */
const DEFAULT_STRENGTH = 128;

/**
 * SEP-0005 derivation path prefix for Stellar accounts.
 */
const SEP5_PATH_PREFIX = "m/44'/148'";

/**
 * Generates a BIP-39 mnemonic phrase.
 *
 * @param strength - Entropy strength in bits. 128 produces a 12-word phrase,
 *                   256 produces a 24-word phrase. Defaults to 128.
 * @returns A BIP-39 mnemonic phrase.
 * @throws {Error} If the strength is not 128 or 256.
 */
export function generateMnemonic(strength: 128 | 256 = DEFAULT_STRENGTH): string {
  if (strength !== 128 && strength !== 256) {
    throw new Error(
      `Invalid mnemonic strength: ${strength}. Must be 128 (12 words) or 256 (24 words).`,
    );
  }
  return bip39.generateMnemonic(strength);
}

/**
 * Validates a BIP-39 mnemonic phrase, checking both the wordlist and checksum.
 *
 * @param mnemonic - The mnemonic phrase to validate.
 * @returns `true` if the mnemonic is valid, `false` otherwise.
 */
export function validateMnemonic(mnemonic: string): boolean {
  if (typeof mnemonic !== 'string' || mnemonic.trim().length === 0) {
    return false;
  }
  try {
    return bip39.validateMnemonic(mnemonic);
  } catch {
    return false;
  }
}

/**
 * Derives a Stellar keypair from a BIP-39 mnemonic using the SEP-0005
 * derivation path `m/44'/148'/<accountIndex>'`.
 *
 * @param mnemonic - A valid BIP-39 mnemonic phrase.
 * @param passphrase - Optional BIP-39 passphrase used during seed derivation.
 * @param accountIndex - The account index for the SEP-0005 path. Defaults to 0.
 * @returns The derived Stellar {@link Keypair}.
 * @throws {Error} If the mnemonic is invalid or the account index is invalid.
 */
export function deriveKeypairFromMnemonic(
  mnemonic: string,
  passphrase: string = '',
  accountIndex: number = 0,
): Keypair {
  if (!validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic: wordlist or checksum verification failed.');
  }

  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error(
      `Invalid account index: ${accountIndex}. Must be a non-negative integer.`,
    );
  }

  const seed = bip39.mnemonicToSeedSync(mnemonic, passphrase);
  const path = `${SEP5_PATH_PREFIX}/${accountIndex}'`;
  const { key } = derivePath(path, seed.toString('hex'));

  return Keypair.fromRawEd25519Seed(Buffer.from(key));
}