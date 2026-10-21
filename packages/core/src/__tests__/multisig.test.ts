import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, Operation, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import { revokeSessionKey } from "../stellar/multisig";
import type { StellarClient } from "../stellar/client";

describe("revokeSessionKey", () => {
  let accountKeypair: Keypair;
  let sessionKeypair: Keypair;
  let fakeAccount: any;
  let mockClient: StellarClient;

  beforeEach(() => {
    accountKeypair = Keypair.random();
    sessionKeypair = Keypair.random();

    fakeAccount = {
      accountId: () => accountKeypair.publicKey(),
      sequenceNumber: () => "123456789",
      incrementSequenceNumber: () => {},
      sequenceNumber: () => "123456789",
      balances: [],
      signers: [],
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    };

    mockClient = {
      horizon: {
        loadAccount: vi.fn().mockResolvedValue(fakeAccount),
        submitTransaction: vi.fn().mockResolvedValue({
          successful: true,
          hash: "abc123hash",
        }),
      },
    } as unknown as StellarClient;
  });

  it("builds a setOptions operation revoking the session signer with weight 0", async () => {
    await revokeSessionKey({
      client: mockClient,
      accountKeypair,
      sessionPublicKey: sessionKeypair.publicKey(),
    });

    expect(mockClient.horizon.loadAccount).toHaveBeenCalledWith(
      accountKeypair.publicKey()
    );

    const submitCall = (mockClient.horizon.submitTransaction as any).mock
      .calls[0][0];
    const tx = submitCall;

    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0];
    expect(op.type).toBe("setOptions");
    expect(op.signer).toBeDefined();
    expect(op.signer.ed25519PublicKey).toBe(sessionKeypair.publicKey());
    expect(op.signer.weight).toBe(0);
  });

  it("signs the transaction with the account keypair", async () => {
    await revokeSessionKey({
      client: mockClient,
      accountKeypair,
      sessionPublicKey: sessionKeypair.publicKey(),
    });

    const tx = (mockClient.horizon.submitTransaction as any).mock.calls[0][0];
    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures[0].hint().toString("hex")).toBe(
      accountKeypair.signatureHint().toString("hex")
    );
  });

  it("returns the hash from the submitted transaction", async () => {
    const result = await revokeSessionKey({
      client: mockClient,
      accountKeypair,
      sessionPublicKey: sessionKeypair.publicKey(),
    });

    expect(result).toEqual({ hash: "abc123hash" });
    expect(mockClient.horizon.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("throws when submission fails", async () => {
    (mockClient.horizon.submitTransaction as any).mockRejectedValueOnce(
      new Error("submission failed")
    );

    await expect(
      revokeSessionKey({
        client: mockClient,
        accountKeypair,
        sessionPublicKey: sessionKeypair.publicKey(),
      })
    ).rejects.toThrow("submission failed");
  });
});