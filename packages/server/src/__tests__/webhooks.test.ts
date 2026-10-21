import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  Keypair,
  Account,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  Networks,
} from "@stellar/stellar-sdk";
import { createServer, type ServerResult } from "../server.js";
import { EnvSigner } from "../signers/EnvSigner.js";
import { signTestToken } from "./helpers/jwt.js";

describe("Webhooks API & Server Integration", () => {
  const cosignerKeypair = Keypair.random();
  const feePayerKeypair = Keypair.random();
  const TEST_PORT = 3891;
  const BASE_URL = `http://localhost:${TEST_PORT}`;
  let serverResult: ServerResult;

  beforeAll(async () => {
    serverResult = createServer({
      port: TEST_PORT,
      network: "local",
      cosignerSigner: new EnvSigner(cosignerKeypair.secret()),
      feePayerSigner: new EnvSigner(feePayerKeypair.secret()),
    });
    // Give server a moment to listen
    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(async () => {
    serverResult.sponsorMonitorService?.stop();
    await new Promise<void>((resolve) => serverResult.server.close(() => resolve()));
  });

  it("registers, lists, and deletes webhooks via API", async () => {
    // 1. Register webhook
    const regRes = await fetch(`${BASE_URL}/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/api/notify",
        secret: "super-secret",
        events: ["transaction.cosigned", "policy.violated"],
      }),
    });

    expect(regRes.status).toBe(201);
    const regData = await regRes.json();
    expect(regData.id).toBeDefined();
    expect(regData.url).toBe("https://example.com/api/notify");
    expect(regData.events).toEqual(["transaction.cosigned", "policy.violated"]);

    const webhookId = regData.id;

    // 2. List webhooks (secret should be omitted)
    const listRes = await fetch(`${BASE_URL}/webhooks`);
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(Array.isArray(listData)).toBe(true);
    const found = listData.find((w: any) => w.id === webhookId);
    expect(found).toBeDefined();
    expect(found.secret).toBeUndefined();

    // 3. Delete webhook
    const delRes = await fetch(`${BASE_URL}/webhooks/${webhookId}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(204);

    // Verify deleted
    const listAfterRes = await fetch(`${BASE_URL}/webhooks`);
    const listAfter = await listAfterRes.json();
    expect(listAfter.some((w: any) => w.id === webhookId)).toBe(false);
  });

  it("returns persistent delivery history via API", async () => {
    const history = [
      {
        deliveryId: "delivery-1",
        event: "transaction.cosigned" as const,
        timestamp: "2026-09-25T12:00:00.000Z",
        deliveredAt: "2026-09-25T12:00:01.000Z",
        webhookId: "wh-1",
        url: "https://example.com/webhook",
        success: false,
        statusCode: 500,
        attempts: 3,
        error: "HTTP 500",
        data: { txHash: "abc" },
      },
    ];
    vi.spyOn(serverResult.webhookDispatcher, "getDeliveryLog").mockResolvedValue(history);

    const response = await fetch(`${BASE_URL}/webhooks/deliveries`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(history);
    vi.restoreAllMocks();
  });

  it("supports pagination with limit and offset query params on GET /webhooks/deliveries", async () => {
    const history = Array.from({ length: 5 }, (_, i) => ({
      deliveryId: `delivery-${i}`,
      event: "transaction.sponsored" as const,
      timestamp: "2026-09-25T12:00:00.000Z",
      deliveredAt: "2026-09-25T12:00:01.000Z",
      webhookId: `wh-${i}`,
      url: "https://example.com/webhook",
      success: true,
      statusCode: 200,
      attempts: 1,
      data: { index: i },
    }));

    vi.spyOn(serverResult.webhookDispatcher, "getDeliveryLog").mockResolvedValue(history);

    const res = await fetch(`${BASE_URL}/webhooks/deliveries?limit=2&offset=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].deliveryId).toBe("delivery-1");
    expect(body[1].deliveryId).toBe("delivery-2");

    vi.restoreAllMocks();
  });

  it("returns delivery history for a specific webhook via GET /webhooks/:id/deliveries", async () => {
    const history = [
      {
        deliveryId: "delivery-2",
        event: "policy.violated" as const,
        timestamp: "2026-09-25T13:00:00.000Z",
        deliveredAt: null,
        webhookId: "wh-2",
        url: "https://example.com/webhook",
        success: false,
        statusCode: 500,
        attempts: 5,
        error: "HTTP 500",
        data: { reason: "policy" },
      },
    ];
    const historySpy = vi
      .spyOn(serverResult.webhookDispatcher, "getDeliveryLog")
      .mockResolvedValue(history);

    const response = await fetch(`${BASE_URL}/webhooks/wh-2/deliveries`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(history);
    expect(historySpy).toHaveBeenCalledWith("wh-2");
    vi.restoreAllMocks();
  });

  it("re-enqueues a dead-lettered delivery via POST /webhooks/deliveries/:id/retry", async () => {
    const retrySpy = vi
      .spyOn(serverResult.webhookDispatcher, "retryDelivery")
      .mockResolvedValue(true);

    const response = await fetch(`${BASE_URL}/webhooks/deliveries/delivery-2/retry`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.retried).toBe(true);
    expect(retrySpy).toHaveBeenCalledWith("delivery-2");
    vi.restoreAllMocks();
  });

  it("returns 404 when retrying an unknown delivery", async () => {
    vi.spyOn(serverResult.webhookDispatcher, "retryDelivery").mockResolvedValue(false);

    const response = await fetch(`${BASE_URL}/webhooks/deliveries/missing/retry`, {
      method: "POST",
    });

    expect(response.status).toBe(404);
    vi.restoreAllMocks();
  });

  it("denies PATCH /webhooks to auditor and operator roles and logs the attempt", async () => {
    const auditorToken = signTestToken({ sub: "auditor-1", roles: ["auditor"] });
    const operatorToken = signTestToken({ sub: "operator-1", roles: ["operator"] });

    for (const [actorId, token] of [
      ["auditor-1", auditorToken],
      ["operator-1", operatorToken],
    ] as const) {
      const res = await fetch(`${BASE_URL}/webhooks`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ events: ["transaction.cosigned"] }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBeDefined();
    }

    const auditEntries = serverResult.auditLogger.getEntries();
    const denied = auditEntries.filter(
      (e) => e.action === "webhooks.update" && e.outcome === "denied",
    );
    expect(denied.map((e) => e.actorId)).toEqual(
      expect.arrayContaining(["auditor-1", "operator-1"]),
    );
    for (const entry of denied) {
      expect(entry.timestamp).toBeDefined();
    }
  });

  it("allows admin role to PATCH /webhooks", async () => {
    const adminToken = signTestToken({ sub: "admin-1", roles: ["admin"] });

    const res = await fetch(`${BASE_URL}/webhooks`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ events: ["transaction.cosigned"] }),
    });

    expect(res.status).toBe(200);

    const auditEntries = serverResult.auditLogger.getEntries();
    expect(
      auditEntries.some(
        (e) =>
          e.action === "webhooks.update" &&
          e.outcome === "allowed" &&
          e.actorId === "admin-1",
      ),
    ).toBe(true);
  });

  it("dispatches transaction.cosigned webhook event on successful cosign", async () => {
    const dispatchSpy = vi.spyOn(serverResult.webhookDispatcher, "dispatch");

    const userKeypair = Keypair.random();
    const userAccount = new Account(userKeypair.publicKey(), "100");

    const tx = new TransactionBuilder(userAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.STANDALONE,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "10",
        }),
      )
      .setTimeout(180)
      .build();

    tx.sign(userKeypair);

    const res = await fetch(`${BASE_URL}/cosign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        xdr: tx.toXDR(),
        walletAddress: userKeypair.publicKey(),
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.signedXdr).toBeDefined();

    expect(dispatchSpy).toHaveBeenCalledWith(
      "transaction.cosigned",
      expect.objectContaining({
        walletAddress: userKeypair.publicKey(),
      }),
    );
  });
});
