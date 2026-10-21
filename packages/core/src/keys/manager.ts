import { Keypair } from "@stellar/stellar-sdk";
import {
  decryptKeypair,
  encryptKeypair,
  exportKeystore,
  importKeystore,
  type KeystoreEnvelope,
} from "./keystore";
import {
  deriveKeypairFromMnemonic,
  generateMnemonic,
  validateMnemonic,
} from "./mnemonic";

export interface StoredKey {
  publicKey: string;
  encryptedSecret: string;
  createdAt: Date;
}

export type { KeystoreEnvelope };
export {
  KEYSTORE_VERSION,
  DEFAULT_ARGON2ID_PARAMS,
  parseKeystoreEnvelope,
  encryptKeystore,
  decryptKeystore,
} from "./keystore";
export type { Argon2idParams } from "./keystore";

export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

const STORAGE_PREFIX = "lumen:key-manager:";

function createMemoryStorage(): KeyStorage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    key: (index) => Array.from(values.keys())[index] ?? null,
  };
}

function getDefaultStorage(): KeyStorage {
  return typeof globalThis.localStorage === "undefined"
    ? createMemoryStorage()
    : globalThis.localStorage;
}

function parseStoredKey(value: string): StoredKey {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored key data is invalid");
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.publicKey !== "string" ||
    typeof candidate.encryptedSecret !== "string" ||
    typeof candidate.createdAt !== "string"
  ) {
    throw new Error("Stored key data is invalid");
  }

  const createdAt = new Date(candidate.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error("Stored key creation date is invalid");
  }

  return {
    publicKey: candidate.publicKey,
    encryptedSecret: candidate.encryptedSecret,
    createdAt,
  };
}

export class KeyManager {
  private readonly storage: KeyStorage;

  constructor(storage: KeyStorage = getDefaultStorage()) {
    this.storage = storage;
  }

  generateKeypair(): Keypair {
    return Keypair.random();
  }

  /**
   * Generates a new BIP-39 mnemonic phrase and derives the default Stellar
   * keypair (SEP-0005 account index 0) from it.
   */
  createFromMnemonic(strength: 128 | 256 = 128): {
    mnemonic: string;
    keypair: Keypair;
  } {
    const mnemonic = generateMnemonic(strength);
    const keypair = deriveKeypairFromMnemonic(mnemonic);
    return { mnemonic, keypair };
  }

  /**
   * Recovers a Stellar keypair from an existing BIP-39 mnemonic phrase using
   * SEP-0005 derivation.
   */
  recoverFromMnemonic(
    mnemonic: string,
    passphrase?: string,
    accountIndex?: number,
  ): Keypair {
    if (!validateMnemonic(mnemonic)) {
      throw new Error("Invalid mnemonic phrase");
    }
    return deriveKeypairFromMnemonic(mnemonic, passphrase, accountIndex);
  }

  async deriveFromOAuth(provider: string, token: string, salt?: string): Promise<Keypair> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(token),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const data = encoder.encode(`${provider}:${salt ?? "lumen-derivation"}`);
    const signature = await crypto.subtle.sign("HMAC", keyMaterial, data);
    const seed = Buffer.from(new Uint8Array(signature).slice(0, 32));

    return Keypair.fromRawEd25519Seed(seed);
  }

  async store(key: Keypair, passphrase: string): Promise<StoredKey> {
    const envelope = await encryptKeypair(key, passphrase);

    const stored: StoredKey = {
      publicKey: envelope.publicKey,
      encryptedSecret: `${envelope.salt}.${envelope.iv}.${envelope.ciphertext}`,
      createdAt: new Date(envelope.createdAt),
    };
    this.storage.setItem(`${STORAGE_PREFIX}${stored.publicKey}`, JSON.stringify(stored));
    return stored;
  }

  /**
   * Exports a stored key as a versioned AES-256-GCM keystore envelope that can
   * be written to disk and imported on another machine.
   */
  async export(publicKey: string, passphrase: string): Promise<KeystoreEnvelope> {
    const storedValue = this.storage.getItem(`${STORAGE_PREFIX}${publicKey}`);
    if (storedValue === null) throw new Error(`Key not found: ${publicKey}`);
    const stored = parseStoredKey(storedValue);

    return exportKeystore(stored, passphrase);
  }

  /**
   * Imports a versioned keystore envelope, decrypting it and persisting the
   * resulting key in local storage.
   */
  async import(envelope: KeystoreEnvelope | string, passphrase: string): Promise<StoredKey> {
    const storedKey = await importKeystore(envelope, passphrase);
    this.storage.setItem(
      `${STORAGE_PREFIX}${storedKey.publicKey}`,
      JSON.stringify(storedKey),
    );
    return storedKey;
  }

  async load(publicKey: string, passphrase: string): Promise<Keypair> {
    const storedValue = this.storage.getItem(`${STORAGE_PREFIX}${publicKey}`);
    if (storedValue === null) throw new Error(`Key not found: ${publicKey}`);
    const stored = parseStoredKey(storedValue);

    const { keypair } = await decryptKeypair(stored, passphrase);
    return keypair;
  }

  list(): StoredKey[] {
    const storedKeys: StoredKey[] = [];
    for (let index = 0; index < this.storage.length; index++) {
      const storageKey = this.storage.key(index);
      if (storageKey?.startsWith(STORAGE_PREFIX)) {
        const value = this.storage.getItem(storageKey);
        if (value !== null) {
          storedKeys.push(parseStoredKey(value));
        }
      }
    }
    return storedKeys;
  }

  delete(publicKey: string): boolean {
    const storageKey = `${STORAGE_PREFIX}${publicKey}`;
    if (this.storage.getItem(storageKey) === null) {
      return false;
    }
    this.storage.removeItem(storageKey);
    return true;
  }
}
