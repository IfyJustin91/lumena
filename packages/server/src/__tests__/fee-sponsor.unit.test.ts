import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Keypair,
  Account,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  Networks,
  Transaction,
  FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import type { StellarClient } from "@lumen/core";
import { FeeSponsorService } from "../fee-sponsor/service.js";
import { SequenceAllocator } from "../fee-sponsor/sequence-allocator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a simple signed payment transaction on the standalone network and
 * return its XDR.  This is the "inner transaction" passed to wrapFeeBump().
 */
function buildSignedInnerTxXdr(
  senderKeypair: Keypair,
  destination: string,
  amount = "10",
): string {
  const account = new Account(senderKeypair.publicKey(), "100");
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.STANDALONE,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: Asset.native(),
        amount,
      }),
    )
    .setTimeout(180)
    .build();

  tx.sign(senderKeypair);
  return tx.toXDR();
}

/**
 * Create a minimal StellarClient mock with a configurable networkPassphrase
 * and horizon.submitTransaction stub.
 */
function makeMockClient(
  submitImpl?: (tx: unknown) => Promise<{ successful: boolean; hash: string }>,
): StellarClient {
  return {
    networkPassphrase: Networks.STANDALONE,
    horizon: {
      submitTransaction:
        submitImpl ??
        vi.fn().mockResolvedValue({ successful: true, hash: "a".repeat(64) }),
    },
  } as unknown as StellarClient;
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const feePayerKeypair = Keypair.random();

// ---------------------------------------------------------------------------
// wrapFeeBump() tests
// ---------------------------------------------------------------------------

describe("FeeSponsorService.wrapFeeBump()", () => {
  const signer = {
    publicKey: vi.fn(() => feePayerKeypair.publicKey()),
    sign: vi.fn(async (hash: Buffer) => feePayerKeypair.sign(hash)),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a non-empty XDR string", async () => {
    const service = new FeeSponsorService({ client: makeMockClient(), signer });

    const innerXdr = buildSignedInnerTxXdr(
      Keypair.random(),
      Keypair.random().publicKey(),
    );

    const feeBumpXdr = await service.wrapFeeBump(innerXdr);

    expect(typeof feeBumpXdr).toBe("string");
    expect(feeBumpXdr.length).toBeGreaterThan(0);
  });

  it("produces a FeeBumpTransaction when parsed back from XDR", async () => {
    const service = new FeeSponsorService({ client: makeMockClient(), signer });

    const innerXdr = buildSignedInnerTxXdr(
      Keypair.random(),
      Keypair.random().publicKey(),
    );

    const feeBumpXdr = await service.wrapFeeBump(innerXdr);
    const parsed = TransactionBuilder.fromXDR(feeBumpXdr, Networks.STANDALONE);

    expect(parsed).toBeInstanceOf(FeeBumpTransaction);
  });

  it("sets the fee-source account to the signer's public key", async () => {
    const service = new FeeSponsorService({ client: makeMockClient(), signer });

    const innerXdr = buildSignedInnerTxXdr(
      Keypair.random(),
      Keypair.random().publicKey(),
    );

    const feeBumpXdr = await service.wrapFeeBump(innerXdr);
    const feeBump = TransactionBuilder.fromXDR(
      feeBumpXdr,
      Networks.STANDALONE,
    ) as FeeBumpTransaction;

    expect(feeBump.feeSource).toBe(feePayerKeypair.publicKey());
  });

  it("preserves all signatures of the inner transaction without modification", async () => {
    const service = new FeeSponsorService({ client: makeMockClient(), signer });

    const userKeypair = Keypair.random();
    const innerXdr = buildSignedInnerTxXdr(
      userKeypair,
      Keypair.random().publicKey(),
    );

    // Capture inner signatures before wrapping.
    // In stellar-sdk v17 DecoratedSignature.signature is a custom Signature
    // object whose underlying bytes live in `.value` (a Uint8Array).
    const innerBefore = TransactionBuilder.fromXDR(
      innerXdr,
      Networks.STANDALONE,
    ) as Transaction;
    const sigsBefore = innerBefore.signatures.map((s) =>
      Buffer.from((s.signature as any).value as Uint8Array).toString("base64"),
    );

    const feeBumpXdr = await service.wrapFeeBump(innerXdr);
    const feeBump = TransactionBuilder.fromXDR(
      feeBumpXdr,
      Networks.STANDALONE,
    ) as FeeBumpTransaction;
    const innerAfter = feeBump.innerTransaction as Transaction;
    const sigsAfter = innerAfter.signatures.map((s) =>
      Buffer.from((s.signature as any).value as Uint8Array).toString("base64"),
    );

    expect(sigsAfter).toEqual(sigsBefore);
  });

  it("applies the custom baseFee to the fee-bump envelope", async () => {
    const customBaseFee = "2000000";
    const service = new FeeSponsorService({
      client: makeMockClient(),
      signer,
      baseFee: customBaseFee,
    });

    const innerXdr = buildSignedInnerTxXdr(
      Keypair.random(),
      Keypair.random().publicKey(),
    );

    const feeBumpXdr = await service.wrapFeeBump(innerXdr);
    const feeBump = TransactionBuilder.fromXDR(
      feeBumpXdr,
      Networks.STANDALONE,
    ) as FeeBumpTransaction;

    expect(Number(feeBump.fee)).toBeGreaterThanOrEqual(Number(customBaseFee));
  });

  it("calls signer.sign() exactly once with a 32-byte hash buffer", async () => {
    const service = new FeeSponsorService({ client: makeMockClient(), signer });

    const innerXdr = buildSignedInnerTxXdr(
      Keypair.random(),
      Keypair.random().publicKey(),
    );

    await service.wrapFeeBump(innerXdr);

    expect(signer.sign).toHaveBeenCalledTimes(1);
    const hashArg: Buffer = signer.sign.mock.calls[0][0];
    // stellar-sdk v17 passes a Uint8Array (Buffer is a subclass of Uint8Array)
    expect(hashArg).toBeInstanceOf(Uint8Array);
    expect(hashArg.length).toBe(32);
  });

  it("attaches exactly one signature to the fee-bump envelope", async () => {
    const service = new FeeSponsorService({ client: makeMockClient(), signer });

    const innerXdr = buildSignedInnerTxXdr(
      Keypair.random(),
      Keypair.random().publicKey(),
    );

    const feeBumpXdr = await service.wrapFeeBump(innerXdr);
    const feeBump = TransactionBuilder.fromXDR(
      feeBumpXdr,
      Networks.STANDALONE,
    ) as FeeBumpTransaction;

    expect(feeBump.signatures).toHaveLength(1);
  });

  it("throws when the input XDR is already a fee-bump transaction", async () => {
    const service = new FeeSponsorService({ client: makeMockClient(), signer });

    const userKeypair = Keypair.random();
    const innerXdr = buildSignedInnerTxXdr(
      userKeypair,
      Keypair.random().publicKey(),
    );

    const innerTx = TransactionBuilder.fromXDR(
      innerXdr,
      Networks.STANDALONE,
    ) as Transaction;
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      feePayerKeypair,
      BASE_FEE * 2,
      innerTx,
      Networks.STANDALONE,
    );
    feeBump.sign(feePayerKeypair);

    await expect(service.wrapFeeBump(feeBump.toXDR())).rejects.toThrow(
      "Expected a regular transaction, not a fee-bump",
    );
  });
});

// ---------------------------------------------------------------------------
// submit() tests
// ---------------------------------------------------------------------------

describe("FeeSponsorService.submit()", () => {
  const MOCK_HASH = "a".repeat(64);

  const signer = {
    publicKey: vi.fn(() => feePayerKeypair.publicKey()),
    sign: vi.fn(async (hash: Buffer) => feePayerKeypair.sign(hash)),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls horizon.submitTransaction() once and returns the transaction hash", async () => {
    const mockSubmit = vi
      .fn()
      .mockResolvedValue({ successful: true, hash: MOCK_HASH });
    const service = new FeeSponsorService({
      client: makeMockClient(mockSubmit),
      signer,
    });

    const innerXdr = buildSignedInnerTxXdr(
      Keypair.random(),
      Keypair.random().publicKey(),
    );

    const result = await service.submit(innerXdr);

    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(result.hash).toBe(MOCK_HASH);
    expect(result.feeBumpHash).toBe(MOCK_HASH);
  });

  it("passes a FeeBumpTransaction object to horizon.submitTransaction()", async () => {
    const mockSubmit = vi
      .fn()
      .mockResolvedValue({ successful: true, hash: MOCK_HASH });
    const service = new FeeSponsorService({
      client: makeMockClient(mockSubmit),
      signer,
    });

    const innerXdr = buildSignedInnerTxXdr(
      Keypair.random(),
      Keypair.random().publicKey(),
    );

    await service.submit(innerXdr);

    const submittedTx = mockSubmit.mock.calls[0][0];
    expect(submittedTx).toBeInstanceOf(FeeBumpTransaction);
  });

  it("throws when horizon.submitTransaction() reports unsuccessful", async () => {
    const mockSubmit = vi
      .fn()
      .mockResolvedValue({ successful: false, hash: "f".repeat(64) });
    const service = new FeeSponsorService({
      client: makeMockClient(mockSubmit),
      signer,
    });

    const innerXdr = buildSignedInnerTxXdr(
      Keypair.random(),
      Keypair.random().publicKey(),
    );

    await expect(service.submit(innerXdr)).rejects.toThrow(
      "Fee-bump submission failed",
    );
  });

  it("dispatches 'transaction.sponsored' webhook event on success", async () => {
    const mockSubmit = vi
      .fn()
      .mockResolvedValue({ successful: true, hash: MOCK_HASH });
    const mockDispatch = vi.fn().mockResolvedValue(undefined);

    const service = new FeeSponsorService({
      client: makeMockClient(mockSubmit),
      signer,
      webhookDispatcher: { dispatch: mockDispatch } as any,
    });

    const innerXdr = buildSignedInnerTxXdr(
      Keypair.random(),
      Keypair.random().publicKey(),
    );

    await service.submit(innerXdr);
    // Allow the fire-and-forget dispatch promise to settle
    await new Promise((r) => setTimeout(r, 0));

    expect(mockDispatch).toHaveBeenCalledWith("transaction.sponsored", {
      feeSource: feePayerKeypair.publicKey(),
      hash: MOCK_HASH,
    });
  });

  it("does not throw when no webhookDispatcher is configured", async () => {
    const mockSubmit = vi
      .fn()
      .mockResolvedValue({ successful: true, hash: MOCK_HASH });
    const service = new FeeSponsorService({
      client: makeMockClient(mockSubmit),
      signer,
    });

    const innerXdr = buildSignedInnerTxXdr(
      Keypair.random(),
      Keypair.random().publicKey(),
    );

    const result = await service.submit(innerXdr);
    expect(result.hash).toBe(MOCK_HASH);
  });

  it("propagates errors thrown by horizon.submitTransaction()", async () => {
    const mockSubmit = vi
      .fn()
      .mockRejectedValue(new Error("Horizon unreachable"));
    const service = new FeeSponsorService({
      client: makeMockClient(mockSubmit),
      signer,
    });

    const innerXdr = buildSignedInnerTxXdr(
      Keypair.random(),
      Keypair.random().publicKey(),
    );

    await expect(service.submit(innerXdr)).rejects.toThrow(
      "Horizon unreachable",
    );
  });
});

// ---------------------------------------------------------------------------
// publicKey getter
// ---------------------------------------------------------------------------

describe("FeeSponsorService.publicKey", () => {
  it("delegates to the signer's publicKey() method", () => {
    const signer = {
      publicKey: vi.fn(() => feePayerKeypair.publicKey()),
      sign: vi.fn(),
    };
    const service = new FeeSponsorService({ client: makeMockClient(), signer });
    expect(service.publicKey).toBe(feePayerKeypair.publicKey());
    expect(signer.publicKey).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Concurrency: distributed sequence number reservation
// ---------------------------------------------------------------------------

/**
 * In-memory fake of the Redis primitives used by SequenceAllocator.  It
 * emulates atomic INCR and SET NX PX semantics closely enough to exercise the
 * allocator's reservation / rollback logic under concurrency.
 */
function makeFakeRedis() {
  const store = new Map<string, string>();
  const expiries = new Map<string, number>();

  return {
    async incr(key: string): Promise<number> {
      const next = Number(store.get(key) ?? "0") + 1;
      store.set(key, String(next));
      return next;
    },
    async set(
      key: string,
      value: string,
      opts?: { NX?: boolean; PX?: number },
    ): Promise<"OK" | null> {
      if (opts?.NX && store.has(key)) return null;
      store.set(key, value);
      if (opts?.PX) expiries.set(key, Date.now() + opts.PX);
      return "OK";
    },
    async get(key: string): Promise<string | null> {
      const exp = expiries.get(key);
      if (exp !== undefined && exp <= Date.now()) {
        store.delete(key);
        expiries.delete(key);
        return null;
      }
      return store.get(key) ?? null;
    },
    async del(key: string): Promise<number> {
      const had = store.delete(key);
      expiries.delete(key);
      return had ? 1 : 0;
    },
    async eval(_script: string, _numKeys: number, ...args: string[]) {
      // Minimal support for the allocator's compare-and-delete rollback:
      //   if redis.call('GET', KEYS[1]) == ARGV[1] then DEL KEYS[1] end
      const key = args[0];
      const expected = args[1];
      if (store.get(key) === expected) {
        store.delete(key);
        expiries.delete(key);
        return 1;
      }
      return 0;
    },
  };
}

describe("FeeSponsorService concurrency (issue #233)", () => {
  const CONCURRENCY = 50;

  const signer = {
    publicKey: vi.fn(() => feePayerKeypair.publicKey()),
    sign: vi.fn(async (hash: Buffer) => feePayerKeypair.sign(hash)),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits 50 concurrent fee-bumps without a single txBAD_SEQ conflict", async () => {
    const redis = makeFakeRedis();
    const allocator = new SequenceAllocator({
      redis: redis as any,
      key: `seq:${feePayerKeypair.publicKey()}`,
      startSequence: "100",
      reservationTtlMs: 5_000,
    });

    // Horizon mock: rejects any submission whose fee-source sequence number
    // has already been consumed, mirroring real txBAD_SEQ behaviour.
    const consumed = new Set<string>();
    const seenSequences: string[] = [];
    const mockSubmit = vi.fn(async (tx: unknown) => {
      const feeBump = tx as FeeBumpTransaction;
      const seq = feeBump.innerTransaction.sequence;
      if (consumed.has(seq)) {
        const err: any = new Error("txBAD_SEQ");
        err.response = { data: { extras: { result_codes: { transaction: "txBAD_SEQ" } } } };
        throw err;
      }
      consumed.add(seq);
      seenSequences.push(seq);
      return { successful: true, hash: seq.padStart(64, "0").slice(0, 64) };
    });

    const service = new FeeSponsorService({
      client: makeMockClient(mockSubmit),
      signer,
      sequenceAllocator: allocator,
    });

    const innerXdrs = Array.from({ length: CONCURRENCY }, () =>
      buildSignedInnerTxXdr(Keypair.random(), Keypair.random().publicKey()),
    );

    const results = await Promise.all(
      innerXdrs.map((xdr) => service.submit(xdr)),
    );

    expect(results).toHaveLength(CONCURRENCY);
    expect(mockSubmit).toHaveBeenCalledTimes(CONCURRENCY);
    // Every submission succeeded with a distinct sequence number.
    expect(new Set(seenSequences).size).toBe(CONCURRENCY);
    // No reservation leaked.
    expect(await allocator.pendingReservations()).toBe(0);
  });

  it("retries with exponential backoff when Horizon reports txBAD_SEQ", async () => {
    const redis = makeFakeRedis();
    const allocator = new SequenceAllocator({
      redis: redis as any,
      key: `seq:${feePayerKeypair.publicKey()}`,
      startSequence: "100",
      reservationTtlMs: 5_000,
    });

    let attempts = 0;
    const mockSubmit = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 2) {
        const err: any = new Error("txBAD_SEQ");
        err.response = { data: { extras: { result_codes: { transaction: "txBAD_SEQ" } } } };
        throw err;
      }
      return { successful: true, hash: "b".repeat(64) };
    });

    const service = new FeeSponsorService({
      client: makeMockClient(mockSubmit),
      signer,
      sequenceAllocator: allocator,
      maxRetries: 5,
      baseRetryDelayMs: 1,
    });

    const innerXdr = buildSignedInnerTxXdr(
      Keypair.random(),
      Keypair.random().publicKey(),
    );

    const result = await service.submit(innerXdr);
    expect(result.hash).toBe("b".repeat(64));
    expect(attempts).toBe(3);
  });

  it("rolls back the reservation when a submission times out", async () => {
    const redis = makeFakeRedis();
    const allocator = new SequenceAllocator({
      redis: redis as any,
      key: `seq:${feePayerKeypair.publicKey()}`,
      startSequence: "100",
      reservationTtlMs: 20,
    });

    const reservation = await allocator.reserve();
    expect(await allocator.pendingReservations()).toBe(1);

    // Simulate the reservation timing out (holder crashed / hung).
    await new Promise((r) => setTimeout(r, 40));
    await allocator.rollbackExpired();

    expect(await allocator.pendingReservations()).toBe(0);
    // A subsequent reservation reuses the rolled-back sequence number.
    const next = await allocator.reserve();
    expect(next.sequence).toBe(reservation.sequence);
  });
});
