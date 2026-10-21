import { describe, it, expect } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { StellarClient } from "../stellar/client.js";

describe("core/client configuration", () => {
  it("defaults to testnet configuration", () => {
    const client = new StellarClient();
    expect(client.config.network).toBe("testnet");
    expect(client.config.horizonUrl).toContain("testnet");
  });

  it("configures mainnet network correctly", () => {
    const client = new StellarClient({ network: "mainnet" });
    expect(client.config.network).toBe("mainnet");
    expect(client.config.horizonUrl).toBe("https://horizon.stellar.org");
  });

  it("configures futurenet network correctly", () => {
    const client = new StellarClient({ network: "futurenet" });
    expect(client.config.network).toBe("futurenet");
    expect(client.config.horizonUrl).toBe(
      "https://horizon-futurenet.stellar.org",
    );
    expect(client.config.rpcUrl).toBe("https://rpc-futurenet.stellar.org");
    expect(client.config.networkPassphrase).toBe(Networks.FUTURENET);
  });

  it("exposes a batch cosign helper that processes each request", async () => {
    const client = new StellarClient();
    const requests = [
      { xdr: "AAAA", walletAddress: "GAAA" },
      { xdr: "BBBB", walletAddress: "GBBB" },
    ];

    const results = await client.cosignBatch(requests, async (req) => ({
      signedXdr: `${req.xdr}-signed`,
      approved: true,
      reason: "ok",
    }));

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      signedXdr: "AAAA-signed",
      approved: true,
      reason: "ok",
    });
    expect(results[1]).toEqual({
      signedXdr: "BBBB-signed",
      approved: true,
      reason: "ok",
    });
  });

  it("returns a per-request rejection result when a batch item fails", async () => {
    const client = new StellarClient();
    const requests = [
      { xdr: "AAAA", walletAddress: "GAAA" },
      { xdr: "BBBB", walletAddress: "GBBB" },
    ];

    const results = await client.cosignBatch(requests, async (req) => {
      if (req.xdr === "BBBB") {
        throw new Error("policy rejected");
      }
      return { signedXdr: `${req.xdr}-signed`, approved: true, reason: "ok" };
    });

    expect(results).toHaveLength(2);
    expect(results[0].approved).toBe(true);
    expect(results[1]).toEqual({
      signedXdr: "",
      approved: false,
      reason: "policy rejected",
    });
  });
});
