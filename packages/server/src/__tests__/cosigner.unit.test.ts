import { describe, it, expect } from "vitest";
import { Keypair, Account, TransactionBuilder, Operation, Asset, BASE_FEE, Networks, TimeoutInfinite } from "@stellar/stellar-sdk";
import { StellarClient } from "@lumen/core";
import { CosignerService } from "../cosigner/service.js";
import { PolicyEngine } from "../policy/engine.js";
import { EnvSigner } from "../signers/EnvSigner.js";

describe("CosignerService TimeBounds & Expiration Enforcement", () => {
  const cosignerKeypair = Keypair.random();
  const signer = new EnvSigner(cosignerKeypair.secret());
  const client = new StellarClient({ network: "local" });
  const userKeypair = Keypair.random();
  const dummyAccount = new Account(userKeypair.publicKey(), "100");

  it("cosigns transaction when timebounds are valid and within limit", async () => {
    const policyEngine = new PolicyEngine();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
      enforceTimeBounds: true,
      maxValidityWindowSeconds: 300,
    });

    const now = Math.floor(Date.now() / 1000);
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
      timebounds: {
        minTime: now.toString(),
        maxTime: (now + 120).toString(),
      },
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .build();
    tx.sign(userKeypair);

    const result = await cosigner.cosign({
      xdr: tx.toXDR(),
      walletAddress: userKeypair.publicKey(),
    });

    expect(result.approved).toBe(true);
    expect(result.signedXdr).toBeTruthy();
  });

  it("rejects transaction when timebounds are missing and enforceTimeBounds is true", async () => {
    const policyEngine = new PolicyEngine();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
      enforceTimeBounds: true,
    });

    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(TimeoutInfinite)
      .build();
    tx.sign(userKeypair);

    const result = await cosigner.cosign({
      xdr: tx.toXDR(),
      walletAddress: userKeypair.publicKey(),
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("unbounded");
  });

  it("rejects expired transaction", async () => {
    const policyEngine = new PolicyEngine();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
      enforceTimeBounds: true,
    });

    const now = Math.floor(Date.now() / 1000);
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
      timebounds: {
        minTime: (now - 600).toString(),
        maxTime: (now - 10).toString(),
      },
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .build();
    tx.sign(userKeypair);

    const result = await cosigner.cosign({
      xdr: tx.toXDR(),
      walletAddress: userKeypair.publicKey(),
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("expired");
  });

  it("rejects transaction exceeding maximum allowed validity window", async () => {
    const policyEngine = new PolicyEngine();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
      enforceTimeBounds: true,
      maxValidityWindowSeconds: 60,
    });

    const now = Math.floor(Date.now() / 1000);
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
      timebounds: {
        minTime: now.toString(),
        maxTime: (now + 300).toString(), // 300s > 60s
      },
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .build();
    tx.sign(userKeypair);

    const result = await cosigner.cosign({
      xdr: tx.toXDR(),
      walletAddress: userKeypair.publicKey(),
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("exceeds maximum allowed window");
  });
});

describe("CosignerService Security Validations", () => {
  const cosignerKeypair = Keypair.random();
  const signer = new EnvSigner(cosignerKeypair.secret());
  const client = new StellarClient({ network: "local" });
  const userKeypair = Keypair.random();
  const dummyAccount = new Account(userKeypair.publicKey(), "100");

  it("rejects fee-bump transactions with user-friendly error message", async () => {
    const policyEngine = new PolicyEngine();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
    });

    const innerTx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(180)
      .build();
    innerTx.sign(userKeypair);

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      cosignerKeypair,
      BASE_FEE * 2,
      innerTx,
      Networks.STANDALONE
    );
    feeBumpTx.sign(cosignerKeypair);

    const result = await cosigner.cosign({
      xdr: feeBumpTx.toXDR(),
      walletAddress: userKeypair.publicKey(),
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toBe(
      "Fee-bump transactions are not accepted for co-signing. Please submit a regular transaction."
    );
  });

  it("rejects transaction when transaction source does not match wallet address", async () => {
    const policyEngine = new PolicyEngine();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
    });

    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(180)
      .build();
    tx.sign(userKeypair);

    const otherWallet = Keypair.random().publicKey();
    const result = await cosigner.cosign({
      xdr: tx.toXDR(),
      walletAddress: otherWallet,
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toBe("Transaction source does not match wallet address");
  });

  it("rejects transaction when wallet owner has not signed the transaction", async () => {
    const policyEngine = new PolicyEngine();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
    });

    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(180)
      .build();
    // Intentionally unsigned

    const result = await cosigner.cosign({
      xdr: tx.toXDR(),
      walletAddress: userKeypair.publicKey(),
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toBe("Transaction is not signed by the wallet owner");
  });

  it("rejects transaction when signed by another key instead of the wallet owner", async () => {
    const policyEngine = new PolicyEngine();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
    });

    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(180)
      .build();

    const impostorKeypair = Keypair.random();
    tx.sign(impostorKeypair);

    const result = await cosigner.cosign({
      xdr: tx.toXDR(),
      walletAddress: userKeypair.publicKey(),
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toBe("Transaction is not signed by the wallet owner");
  });

  it("approves and co-signs transaction when properly signed by wallet owner and source matches", async () => {
    const policyEngine = new PolicyEngine();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
    });

    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(180)
      .build();
    tx.sign(userKeypair);

    const result = await cosigner.cosign({
      xdr: tx.toXDR(),
      walletAddress: userKeypair.publicKey(),
    });

    expect(result.approved).toBe(true);
    expect(result.signedXdr).toBeTruthy();
  });
});

describe("CosignerService Distributed Sequence Allocation & Backoff", () => {
  const cosignerKeypair = Keypair.random();
  const signer = new EnvSigner(cosignerKeypair.secret());
  const client = new StellarClient({ network: "local" });
  const userKeypair = Keypair.random();
  const dummyAccount = new Account(userKeypair.publicKey(), "100");

  const buildSignedTx = () => {
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(180)
      .build();
    tx.sign(userKeypair);
    return tx;
  };

  const createMockAllocator = () => {
    const reservations = new Map<string, number>();
    const usedSequences = new Set<string>();
    let nextSequence = 1000;
    let conflicts = 0;
    let released = 0;

    const allocator = {
      reserve: async (accountId: string) => {
        const seq = nextSequence++;
        const token = `${accountId}:${seq}`;
        reservations.set(token, seq);
        return { token, sequence: seq.toString() };
      },
      release: async (token: string) => {
        if (reservations.delete(token)) {
          released++;
        }
      },
      commit: async (token: string) => {
        const seq = reservations.get(token);
        if (seq === undefined) return;
        reservations.delete(token);
        usedSequences.add(seq.toString());
      },
      // Simulates Horizon submission; duplicate sequence numbers yield txBAD_SEQ.
      submit: async (sequence: string) => {
        if (usedSequences.has(sequence)) {
          conflicts++;
          const err = new Error("txBAD_SEQ") as Error & { result_codes?: unknown };
          err.result_codes = { transaction: "txBAD_SEQ" };
          throw err;
        }
        usedSequences.add(sequence);
        return { hash: `hash-${sequence}` };
      },
      stats: () => ({ conflicts, released, pending: reservations.size }),
    };

    return allocator;
  };

  it("submits 50 concurrent transactions without sequence conflicts", async () => {
    const policyEngine = new PolicyEngine();
    const allocator = createMockAllocator();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
      sequenceAllocator: allocator as never,
      maxSequenceRetries: 5,
    });

    const items = Array.from({ length: 50 }, () => ({
      xdr: buildSignedTx().toXDR(),
      walletAddress: userKeypair.publicKey(),
    }));

    const results = await Promise.all(items.map((item) => cosigner.cosign(item)));

    expect(results).toHaveLength(50);
    for (const result of results) {
      expect(result.approved).toBe(true);
      expect(result.signedXdr).toBeTruthy();
    }

    const stats = allocator.stats();
    expect(stats.conflicts).toBe(0);
    expect(stats.pending).toBe(0);
  });

  it("retries with exponential backoff on txBAD_SEQ and eventually succeeds", async () => {
    const policyEngine = new PolicyEngine();
    const allocator = createMockAllocator();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
      sequenceAllocator: allocator as never,
      maxSequenceRetries: 5,
    });

    const result = await cosigner.cosign({
      xdr: buildSignedTx().toXDR(),
      walletAddress: userKeypair.publicKey(),
    });

    expect(result.approved).toBe(true);
    expect(result.signedXdr).toBeTruthy();
    expect(allocator.stats().pending).toBe(0);
  });

  it("releases the sequence reservation when submission fails", async () => {
    const policyEngine = new PolicyEngine();
    const allocator = createMockAllocator();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
      sequenceAllocator: allocator as never,
      maxSequenceRetries: 2,
    });

    const failingAllocator = {
      ...allocator,
      submit: async () => {
        throw new Error("txBAD_SEQ");
      },
    };

    const failingCosigner = new CosignerService({
      client,
      signer,
      policyEngine,
      sequenceAllocator: failingAllocator as never,
      maxSequenceRetries: 2,
    });

    const result = await failingCosigner.cosign({
      xdr: buildSignedTx().toXDR(),
      walletAddress: userKeypair.publicKey(),
    });

    expect(result.approved).toBe(false);
    expect(allocator.stats().pending).toBe(0);
  });
});

describe("CosignerService Batch Cosigning", () => {
  const cosignerKeypair = Keypair.random();
  const signer = new EnvSigner(cosignerKeypair.secret());
  const client = new StellarClient({ network: "local" });
  const userKeypair = Keypair.random();
  const dummyAccount = new Account(userKeypair.publicKey(), "100");

  const buildSignedTx = (amount = "10") => {
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount,
        })
      )
      .setTimeout(180)
      .build();
    tx.sign(userKeypair);
    return tx;
  };

  it("co-signs a batch of 20 valid transactions in a single request", async () => {
    const policyEngine = new PolicyEngine();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
    });

    const items = Array.from({ length: 20 }, () => ({
      xdr: buildSignedTx().toXDR(),
      walletAddress: userKeypair.publicKey(),
    }));

    const result = await cosigner.cosignBatch(items);

    expect(result.results).toHaveLength(20);
    expect(result.approvedCount).toBe(20);
    expect(result.rejectedCount).toBe(0);
    for (const item of result.results) {
      expect(item.approved).toBe(true);
      expect(item.signedXdr).toBeTruthy();
      expect(item.index).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns item-level error details for invalid transactions in the batch", async () => {
    const policyEngine = new PolicyEngine();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
    });

    const validTx = buildSignedTx();
    const unsignedTx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        })
      )
      .setTimeout(180)
      .build();

    const result = await cosigner.cosignBatch([
      { xdr: validTx.toXDR(), walletAddress: userKeypair.publicKey() },
      { xdr: unsignedTx.toXDR(), walletAddress: userKeypair.publicKey() },
      { xdr: "not-a-valid-xdr", walletAddress: userKeypair.publicKey() },
    ]);

    expect(result.results).toHaveLength(3);
    expect(result.approvedCount).toBe(1);
    expect(result.rejectedCount).toBe(2);

    expect(result.results[0].approved).toBe(true);
    expect(result.results[0].signedXdr).toBeTruthy();

    expect(result.results[1].approved).toBe(false);
    expect(result.results[1].index).toBe(1);
    expect(result.results[1].reason).toBe("Transaction is not signed by the wallet owner");

    expect(result.results[2].approved).toBe(false);
    expect(result.results[2].index).toBe(2);
    expect(result.results[2].reason).toBeTruthy();
  });

  it("evaluates each item independently so one failure does not block valid items", async () => {
    const policyEngine = new PolicyEngine();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
    });

    const otherWallet = Keypair.random().publicKey();
    const validTx = buildSignedTx();

    const result = await cosigner.cosignBatch([
      { xdr: validTx.toXDR(), walletAddress: otherWallet },
      { xdr: buildSignedTx().toXDR(), walletAddress: userKeypair.publicKey() },
    ]);

    expect(result.results[0].approved).toBe(false);
    expect(result.results[0].reason).toBe("Transaction source does not match wallet address");
    expect(result.results[1].approved).toBe(true);
    expect(result.results[1].signedXdr).toBeTruthy();
  });

  it("propagates fraud rejections per item with FRAUD_VELOCITY_TRIGGERED", async () => {
    const policyEngine = new PolicyEngine();
    const fraudDetector = {
      evaluate: async () => ({
        blocked: true,
        score: 95,
        violations: ["FRAUD_VELOCITY_TRIGGERED"],
      }),
    };
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
      fraudDetector: fraudDetector as never,
    });

    const result = await cosigner.cosignBatch([
      { xdr: buildSignedTx().toXDR(), walletAddress: userKeypair.publicKey() },
      { xdr: buildSignedTx().toXDR(), walletAddress: userKeypair.publicKey() },
    ]);

    expect(result.approvedCount).toBe(0);
    expect(result.rejectedCount).toBe(2);
    for (const item of result.results) {
      expect(item.approved).toBe(false);
      expect(item.reason).toContain("FRAUD_VELOCITY_TRIGGERED");
    }
  });

  it("returns an empty result set for an empty batch", async () => {
    const policyEngine = new PolicyEngine();
    const cosigner = new CosignerService({
      client,
      signer,
      policyEngine,
    });

    const result = await cosigner.cosignBatch([]);

    expect(result.results).toHaveLength(0);
    expect(result.approvedCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
  });
});
