import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createObserverGateway,
  deriveRunAccessToken,
  gatewayPathAllowed,
  issueRunAccessToken,
  loadOrCreateGatewaySecret,
  readAccessRecords,
  validatePublicGatewayUrl,
  verifyRunAccessToken,
  writeAccessRecords,
} from "../src/observer/gateway.js";

async function observer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === "/styles.css") {
      response.setHeader("content-type", "text/css");
      response.end("body{}");
      return;
    }
    if (request.url?.startsWith("/api/v1/runs/")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end("dashboard");
  });
  await new Promise<void>((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () =>
      new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      ),
  };
}

test("run token stores only hash, persists privately, and expires", () => {
  const dir = mkdtempSync(join(tmpdir(), "maquila-gateway-"));
  try {
    const runId = randomUUID();
    const issued = issueRunAccessToken(runId, 10_000, 1_000);
    assert.notEqual(issued.record.tokenHash, issued.token);
    assert.equal(verifyRunAccessToken(issued.record, runId, issued.token, 2_000), true);
    assert.equal(verifyRunAccessToken(issued.record, runId, issued.token, 12_000), false);
    const path = join(dir, "access.json");
    writeAccessRecords(path, new Map([[runId, issued.record]]));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(path, "utf8"), new RegExp(issued.token));
    assert.equal(readAccessRecords(path, 2_000).get(runId)?.tokenHash, issued.record.tokenHash);
    assert.equal(readAccessRecords(path, 12_000).size, 0);
    const secretPath = join(dir, "gateway.secret");
    const secret = loadOrCreateGatewaySecret(secretPath);
    assert.equal(statSync(secretPath).mode & 0o777, 0o600);
    const expiresAt = new Date(12_000).toISOString();
    const first = deriveRunAccessToken(runId, secret, expiresAt);
    const second = deriveRunAccessToken(runId, loadOrCreateGatewaySecret(secretPath), expiresAt);
    assert.deepEqual(first, second);
    assert.doesNotMatch(JSON.stringify(first.record), new RegExp(first.token));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public gateway requires an exact HTTPS origin", () => {
  assert.equal(
    validatePublicGatewayUrl("https://controller.exe.xyz").origin,
    "https://controller.exe.xyz",
  );
  assert.throws(() => validatePublicGatewayUrl("http://controller.exe.xyz"), /HTTPS origin/);
  assert.throws(() => validatePublicGatewayUrl("https://controller.exe.xyz/path"), /HTTPS origin/);
});

test("gateway allowlist is run scoped", () => {
  const runId = randomUUID();
  assert.equal(gatewayPathAllowed(`/runs/${runId}`, runId), true);
  assert.equal(gatewayPathAllowed(`/api/v1/runs/${runId}/events`, runId), true);
  assert.equal(gatewayPathAllowed(`/api/v1/runs`, runId), false);
  assert.equal(gatewayPathAllowed(`/runs/${runId}/other`, runId), false);
});

test("gateway bootstraps secure cookie and limits assets and APIs to one run", async () => {
  const upstream = await observer();
  const runId = randomUUID();
  const otherRunId = randomUUID();
  const issued = issueRunAccessToken(runId);
  let webhookBody = "";
  const gateway = await createObserverGateway({
    port: 0,
    observerUrl: upstream.url,
    publicBaseUrl: "https://maquila-controller.exe.xyz",
    tokens: new Map([[runId, issued.record]]),
    webhook: async (request, response) => {
      for await (const chunk of request) webhookBody += Buffer.from(chunk).toString("utf8");
      response.statusCode = 200;
      response.end();
    },
  });
  const base = `http://127.0.0.1:${gateway.port()}`;
  try {
    const denied = await fetch(`${base}/styles.css`);
    assert.equal(denied.status, 404);
    const bootstrap = await fetch(`${base}/runs/${runId}?token=${issued.token}`, {
      redirect: "manual",
    });
    assert.equal(bootstrap.status, 303);
    assert.equal(bootstrap.headers.get("location"), `/runs/${runId}`);
    const setCookie = bootstrap.headers.get("set-cookie");
    assert.match(setCookie ?? "", /HttpOnly; Secure; SameSite=Strict/);
    const cookie = setCookie?.split(";", 1)[0];
    assert.ok(cookie);
    assert.equal((await fetch(`${base}/styles.css`, { headers: { cookie } })).status, 200);
    assert.equal(
      (await fetch(`${base}/api/v1/runs/${runId}`, { headers: { cookie } })).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/api/v1/runs/${otherRunId}`, { headers: { cookie } })).status,
      404,
    );
    const webhook = await fetch(`${base}/hooks/linear`, { method: "POST", body: "raw-body" });
    assert.equal(webhook.status, 200);
    assert.equal(webhookBody, "raw-body");
  } finally {
    await gateway.close();
    await upstream.close();
  }
});
