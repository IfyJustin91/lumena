import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createServer, type ServerResult } from "../server.js";
import { EnvSigner } from "../signers/EnvSigner.js";
import { signRoleToken, type Role } from "../middleware/rbac.js";

describe("Policy API", () => {
  let serverResult: ServerResult;
  let baseUrl: string;
  let jwtSecret: string;

  const tokenFor = (role: Role, actorId = `${role}-actor`): string =>
    signRoleToken({ sub: actorId, role }, jwtSecret);

  const authHeaders = (role: Role, actorId?: string): Record<string, string> => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${tokenFor(role, actorId)}`,
  });

  beforeAll(async () => {
    const cosignerKeypair = Keypair.random();
    const feePayerKeypair = Keypair.random();
    jwtSecret = "policy-api-test-secret";
    serverResult = createServer({
      port: 0,
      network: "local",
      cosignerSigner: new EnvSigner(cosignerKeypair.secret()),
      feePayerSigner: new EnvSigner(feePayerKeypair.secret()),
      jwtSecret,
    });
    await new Promise<void>((resolve) => serverResult.server.once("listening", resolve));
    const address = serverResult.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Policy API test server did not bind to a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    serverResult.sponsorMonitorService.stop();
    await new Promise<void>((resolve) => serverResult.server.close(() => resolve()));
  });

  it("updates an existing policy with PUT without changing its identity", async () => {
    const walletId = Keypair.random().publicKey();
    const initialRules = [{ type: "max_operations", maxOperations: 2 }];
    const createResponse = await fetch(`${baseUrl}/policy`, {
      method: "POST",
      headers: authHeaders("admin"),
      body: JSON.stringify({ walletId, rules: initialRules }),
    });
    expect(createResponse.status).toBe(201);
    const createdPolicy = await createResponse.json();

    expect(createdPolicy.version).toBe(1);

    const updatedRules = [{ type: "max_operations", maxOperations: 5 }];
    const updateResponse = await fetch(`${baseUrl}/policy/${walletId}`, {
      method: "PUT",
      headers: { ...authHeaders("admin"), "If-Match": "1" },
      body: JSON.stringify({ walletId, rules: updatedRules }),
    });

    expect(updateResponse.status).toBe(200);
    expect(updateResponse.headers.get("etag")).toBe("2");
    const updatedPolicy = await updateResponse.json();
    expect(updatedPolicy).toMatchObject({
      id: createdPolicy.id,
      walletId,
      rules: updatedRules,
      createdAt: createdPolicy.createdAt,
      version: 2,
    });

    const duplicateResponse = await fetch(`${baseUrl}/policy`, {
      method: "POST",
      headers: authHeaders("admin"),
      body: JSON.stringify({ walletId, rules: initialRules }),
    });
    expect(duplicateResponse.status).toBe(409);
  });

  it("requires an existing policy and matching URL walletId for PUT", async () => {
    const walletId = Keypair.random().publicKey();
    const missingResponse = await fetch(`${baseUrl}/policy/${walletId}`, {
      method: "PUT",
      headers: authHeaders("admin"),
      body: JSON.stringify({
        walletId,
        rules: [{ type: "max_operations", maxOperations: 2 }],
      }),
    });
    expect(missingResponse.status).toBe(404);

    const existingWalletId = Keypair.random().publicKey();
    await fetch(`${baseUrl}/policy`, {
      method: "POST",
      headers: authHeaders("admin"),
      body: JSON.stringify({
        walletId: existingWalletId,
        rules: [{ type: "max_operations", maxOperations: 2 }],
      }),
    });

    const mismatchResponse = await fetch(`${baseUrl}/policy/${existingWalletId}`, {
      method: "PUT",
      headers: { ...authHeaders("admin"), "If-Match": "1" },
      body: JSON.stringify({
        walletId,
        rules: [{ type: "max_operations", maxOperations: 3 }],
      }),
    });
    expect(mismatchResponse.status).toBe(400);
  });

  it("detects concurrent update conflicts via If-Match versioning", async () => {
    const walletId = Keypair.random().publicKey();
    const createResponse = await fetch(`${baseUrl}/policy`, {
      method: "POST",
      headers: authHeaders("admin"),
      body: JSON.stringify({
        walletId,
        rules: [{ type: "max_operations", maxOperations: 2 }],
      }),
    });
    expect(createResponse.status).toBe(201);
    const createdPolicy = await createResponse.json();
    expect(createdPolicy.version).toBe(1);

    const firstUpdate = await fetch(`${baseUrl}/policy/${walletId}`, {
      method: "PUT",
      headers: { ...authHeaders("admin"), "If-Match": "1" },
      body: JSON.stringify({
        walletId,
        rules: [{ type: "max_operations", maxOperations: 5 }],
      }),
    });
    expect(firstUpdate.status).toBe(200);
    expect(firstUpdate.headers.get("etag")).toBe("2");
    const firstUpdatedPolicy = await firstUpdate.json();
    expect(firstUpdatedPolicy.version).toBe(2);

    const staleUpdate = await fetch(`${baseUrl}/policy/${walletId}`, {
      method: "PUT",
      headers: { ...authHeaders("admin"), "If-Match": "1" },
      body: JSON.stringify({
        walletId,
        rules: [{ type: "max_operations", maxOperations: 10 }],
      }),
    });
    expect(staleUpdate.status).toBe(412);
    const staleError = await staleUpdate.json();
    expect(staleError.error).toMatch(/version/i);

    const missingIfMatch = await fetch(`${baseUrl}/policy/${walletId}`, {
      method: "PUT",
      headers: authHeaders("admin"),
      body: JSON.stringify({
        walletId,
        rules: [{ type: "max_operations", maxOperations: 10 }],
      }),
    });
    expect(missingIfMatch.status).toBe(412);
    const missingError = await missingIfMatch.json();
    expect(missingError.error).toMatch(/If-Match/i);
  });

  it("rejects unauthenticated policy creation with 401", async () => {
    const response = await fetch(`${baseUrl}/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletId: Keypair.random().publicKey(),
        rules: [{ type: "max_operations", maxOperations: 2 }],
      }),
    });
    expect(response.status).toBe(401);
  });

  it("forbids auditor from creating a policy and records the attempt", async () => {
    const actorId = "auditor-1";
    const response = await fetch(`${baseUrl}/policy`, {
      method: "POST",
      headers: authHeaders("auditor", actorId),
      body: JSON.stringify({
        walletId: Keypair.random().publicKey(),
        rules: [{ type: "max_operations", maxOperations: 2 }],
      }),
    });
    expect(response.status).toBe(403);

    const auditLog = serverResult.auditLogger.getEntries();
    const entry = auditLog.find(
      (record) =>
        record.actorId === actorId &&
        record.action === "policy:create" &&
        record.outcome === "denied",
    );
    expect(entry).toBeDefined();
    expect(entry?.role).toBe("auditor");
    expect(typeof entry?.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(entry!.timestamp))).toBe(false);
  });

  it("allows auditor to read policies", async () => {
    const response = await fetch(`${baseUrl}/policy`, {
      method: "GET",
      headers: authHeaders("auditor"),
    });
    expect(response.status).toBe(200);
  });

  it("allows operator to update a policy but not create one", async () => {
    const walletId = Keypair.random().publicKey();
    const createResponse = await fetch(`${baseUrl}/policy`, {
      method: "POST",
      headers: authHeaders("admin"),
      body: JSON.stringify({
        walletId,
        rules: [{ type: "max_operations", maxOperations: 2 }],
      }),
    });
    expect(createResponse.status).toBe(201);

    const updateResponse = await fetch(`${baseUrl}/policy/${walletId}`, {
      method: "PUT",
      headers: { ...authHeaders("operator"), "If-Match": "1" },
      body: JSON.stringify({
        walletId,
        rules: [{ type: "max_operations", maxOperations: 4 }],
      }),
    });
    expect(updateResponse.status).toBe(200);

    const forbiddenCreate = await fetch(`${baseUrl}/policy`, {
      method: "POST",
      headers: authHeaders("operator"),
      body: JSON.stringify({
        walletId: Keypair.random().publicKey(),
        rules: [{ type: "max_operations", maxOperations: 2 }],
      }),
    });
    expect(forbiddenCreate.status).toBe(403);
  });

  it("forbids operator from admin-only routes", async () => {
    const response = await fetch(`${baseUrl}/wallets`, {
      method: "GET",
      headers: authHeaders("operator"),
    });
    expect(response.status).toBe(403);
  });

  it("grants admin full access and logs allowed actions with actor and timestamp", async () => {
    const actorId = "admin-1";
    const response = await fetch(`${baseUrl}/wallets`, {
      method: "GET",
      headers: authHeaders("admin", actorId),
    });
    expect(response.status).toBe(200);

    const entry = serverResult.auditLogger
      .getEntries()
      .find(
        (record) =>
          record.actorId === actorId &&
          record.action === "wallets:list" &&
          record.outcome === "allowed",
      );
    expect(entry).toBeDefined();
    expect(entry?.role).toBe("admin");
    expect(typeof entry?.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(entry!.timestamp))).toBe(false);
  });
});
