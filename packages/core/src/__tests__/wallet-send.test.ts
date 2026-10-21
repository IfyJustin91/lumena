import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Asset,
  Keypair,
  Memo,
  TransactionBuilder,
  Account,
  Networks,
} from "@stellar/stellar-sdk";
import type { StellarClient } from "../stellar/client.js";
import { Wallet } from "../wallet/wallet.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function createWallet(serverUrl?: string) {
  const ownerKeypair = Keypair.random();
  const submitTransaction = vi.fn();
  const wallet = new Wallet({
    client: {
      horizon: { submitTransaction },
    } as unknown as StellarClient,
    sponsorKeypair: Keypair.random(),
    serverPublicKey: Keypair.random().publicKey(),
    serverUrl,
    ownerKeypair,
  });
  Object.defineProperty(wallet, "_address", { value: ownerKeypair.publicKey() });
  vi.spyOn(wallet, "buildPaymentTransaction").mockResolvedValue("owner-signed-xdr");
  return { wallet, submitTransaction, ownerKeypair };
}

describe("Wallet.send", () => {
  it("routes signed payments through co-signing and sponsored submission", async () => {
    const { wallet, submitTransaction, ownerKeypair } = createWallet("https://lumen.example/");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ signedXdr: "cosigned-xdr" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hash: "fee-bump-hash" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(wallet.send(Keypair.random().publicKey(), Asset.native(), "1")).resolves.toEqual({
      hash: "fee-bump-hash",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://lumen.example/cosign");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      xdr: "owner-signed-xdr",
      walletAddress: ownerKeypair.publicKey(),
    });
    expect(fetchMock.mock.calls[1][0]).toBe("https://lumen.example/fee-bump/submit");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      xdr: "cosigned-xdr",
    });
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it("does not send payments directly when no Lumen server URL is configured", async () => {
    const { wallet, submitTransaction } = createWallet();

    await expect(wallet.send(Keypair.random().publicKey(), Asset.native(), "1")).rejects.toThrow(
      "A Lumen server URL is required",
    );
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it("forwards the memo to buildPaymentTransaction", async () => {
    const { wallet } = createWallet("https://lumen.example/");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ signedXdr: "cosigned-xdr" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hash: "fee-bump-hash" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const destination = Keypair.random().publicKey();
    const memo = Memo.text("hello");

    await wallet.send(destination, Asset.native(), "1", memo);

    expect(wallet.buildPaymentTransaction).toHaveBeenCalledWith(
      destination,
      Asset.native(),
      "1",
      memo,
    );
  });
});

describe("Wallet.buildPaymentTransaction memo handling", () => {
  function createBuildWallet() {
    const ownerKeypair = Keypair.random();
    const loadAccount = vi.fn().mockResolvedValue(new Account(ownerKeypair.publicKey(), "1"));
    const wallet = new Wallet({
      client: {
        horizon: { loadAccount },
      } as unknown as StellarClient,
      sponsorKeypair: Keypair.random(),
      serverPublicKey: Keypair.random().publicKey(),
      ownerKeypair,
    });
    Object.defineProperty(wallet, "_address", { value: ownerKeypair.publicKey() });
    return { wallet, ownerKeypair };
  }

  function decodeMemo(xdr: string) {
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    return (tx as { memo: Memo }).memo;
  }

  it("builds a transaction with a text memo from a string", async () => {
    const { wallet } = createBuildWallet();

    const xdr = await wallet.buildPaymentTransaction(
      Keypair.random().publicKey(),
      Asset.native(),
      "1",
      "hello",
    );

    const memo = decodeMemo(xdr);
    expect(memo.type).toBe(Memo.text("").type);
    expect(memo.value.toString()).toBe("hello");
  });

  it("builds a transaction with a Memo.text memo", async () => {
    const { wallet } = createBuildWallet();

    const xdr = await wallet.buildPaymentTransaction(
      Keypair.random().publicKey(),
      Asset.native(),
      "1",
      Memo.text("text-memo"),
    );

    const memo = decodeMemo(xdr);
    expect(memo.type).toBe(Memo.text("").type);
    expect(memo.value.toString()).toBe("text-memo");
  });

  it("builds a transaction with a Memo.id memo", async () => {
    const { wallet } = createBuildWallet();

    const xdr = await wallet.buildPaymentTransaction(
      Keypair.random().publicKey(),
      Asset.native(),
      "1",
      Memo.id("12345"),
    );

    const memo = decodeMemo(xdr);
    expect(memo.type).toBe(Memo.id("").type);
    expect(memo.value.toString()).toBe("12345");
  });

  it("builds a transaction with a Memo.hash memo", async () => {
    const { wallet } = createBuildWallet();
    const hash = Buffer.alloc(32, 7);

    const xdr = await wallet.buildPaymentTransaction(
      Keypair.random().publicKey(),
      Asset.native(),
      "1",
      Memo.hash(hash),
    );

    const memo = decodeMemo(xdr);
    expect(memo.type).toBe(Memo.hash(Buffer.alloc(32)).type);
    expect(Buffer.from(memo.value as Buffer)).toEqual(hash);
  });
});
