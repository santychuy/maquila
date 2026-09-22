import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_RECORDS = 1_000;
const COOKIE = "maquila_run";

export interface RunAccessToken {
  runId: string;
  tokenHash: string;
  expiresAt: string;
  revoked?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === "string" ? value.code : undefined;
}

function validRecord(value: unknown): value is RunAccessToken {
  if (!isRecord(value)) return false;
  const entry = value;
  return (
    Object.keys(entry).every((key) =>
      ["runId", "tokenHash", "expiresAt", "revoked"].includes(key),
    ) &&
    typeof entry.runId === "string" &&
    UUID.test(entry.runId) &&
    typeof entry.tokenHash === "string" &&
    HASH.test(entry.tokenHash) &&
    typeof entry.expiresAt === "string" &&
    Number.isFinite(Date.parse(entry.expiresAt)) &&
    (entry.revoked === undefined || typeof entry.revoked === "boolean")
  );
}

export function writeAccessRecords(path: string, records: Map<string, RunAccessToken>): void {
  if (
    records.size > MAX_RECORDS ||
    [...records].some(([runId, record]) => runId !== record.runId || !validRecord(record))
  )
    throw new Error("gateway records malformed");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  const value = {
    version: 1,
    records: [...records.values()].toSorted((a, b) => a.runId.localeCompare(b.runId)),
  };
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function readAccessRecords(path: string, now = Date.now()): Map<string, RunAccessToken> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value)) throw new Error("gateway records malformed");
    const root = value;
    if (
      root.version !== 1 ||
      !Array.isArray(root.records) ||
      root.records.length > MAX_RECORDS ||
      !Object.keys(root).every((key) => ["version", "records"].includes(key)) ||
      !root.records.every(validRecord)
    )
      throw new Error("gateway records malformed");
    const records = new Map<string, RunAccessToken>();
    for (const record of root.records) {
      if (Date.parse(record.expiresAt) > now && record.revoked !== true)
        records.set(record.runId, record);
    }
    return records;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return new Map();
    throw error;
  }
}

export function loadOrCreateGatewaySecret(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("gateway secret path invalid");
    const secret = readFileSync(path, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("gateway secret malformed");
    chmodSync(path, 0o600);
    return secret;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const secret = randomBytes(32).toString("base64url");
    try {
      writeFileSync(path, `${secret}\n`, { flag: "wx", mode: 0o600 });
      return secret;
    } catch (writeError) {
      if (errorCode(writeError) === "EEXIST") return loadOrCreateGatewaySecret(path);
      throw writeError;
    }
  }
}

export function deriveRunAccessToken(
  runId: string,
  secret: string,
  expiresAt: string,
): { token: string; record: RunAccessToken } {
  if (!UUID.test(runId)) throw new Error("run ID invalid");
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("gateway secret invalid");
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error("token expiry invalid");
  const token = createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(`maquila-run-access-v1\0${runId}\0${expiresAt}`)
    .digest("base64url");
  return { token, record: { runId, tokenHash: hashToken(token), expiresAt } };
}

export function issueRunAccessToken(
  runId: string,
  ttlMs = 60 * 60 * 1000,
  now = Date.now(),
): { token: string; record: RunAccessToken } {
  if (!UUID.test(runId)) throw new Error("run ID invalid");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1000)
    throw new Error("token TTL invalid");
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    record: { runId, tokenHash: hashToken(token), expiresAt: new Date(now + ttlMs).toISOString() },
  };
}

export function verifyRunAccessToken(
  record: RunAccessToken,
  runId: string,
  token: string,
  now = Date.now(),
): boolean {
  if (
    !validRecord(record) ||
    record.runId !== runId ||
    record.revoked === true ||
    Date.parse(record.expiresAt) <= now ||
    !TOKEN.test(token)
  )
    return false;
  const expected = Buffer.from(record.tokenHash, "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function gatewayPathAllowed(pathname: string, runId: string): boolean {
  if (!UUID.test(runId)) return false;
  return (
    pathname === `/runs/${runId}` ||
    pathname === `/api/v1/runs/${runId}` ||
    pathname.startsWith(`/api/v1/runs/${runId}/`)
  );
}

function cookie(request: IncomingMessage): { runId: string; token: string } | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, value, ...rest] = part.trim().split("=");
    if (name !== COOKIE || !value || rest.length > 0) continue;
    const separator = value.indexOf(".");
    if (separator < 0) return undefined;
    const runId = value.slice(0, separator);
    const token = value.slice(separator + 1);
    return UUID.test(runId) && TOKEN.test(token) ? { runId, token } : undefined;
  }
  return undefined;
}

export function validatePublicGatewayUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error("public URL must be an HTTPS origin");
  return url;
}

export interface GatewayServer {
  close(): Promise<void>;
  port(): number;
  url(runId: string, token: string): string;
}

export async function createObserverGateway(options: {
  port: number;
  observerUrl: string;
  webhook: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  tokens: Map<string, RunAccessToken>;
  publicBaseUrl: string;
  bindHost?: string;
}): Promise<GatewayServer> {
  const observer = new URL(options.observerUrl);
  const publicBase = validatePublicGatewayUrl(options.publicBaseUrl);
  if (observer.hostname !== "127.0.0.1" || observer.protocol !== "http:")
    throw new Error("observer must be loopback HTTP");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)
    throw new Error("gateway port invalid");
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/hooks/linear") {
        await options.webhook(request, response);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.statusCode = 405;
        response.end();
        return;
      }
      const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
      const match =
        incoming.pathname.match(/^\/runs\/([0-9a-f-]{36})$/i) ??
        incoming.pathname.match(/^\/api\/v1\/runs\/([0-9a-f-]{36})(?:\/.*)?$/i);
      const storedCookie = cookie(request);
      const pathRunId = match?.[1];
      const runId = pathRunId ?? storedCookie?.runId;
      const queryToken = incoming.searchParams.get("token") ?? undefined;
      const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/i)?.[1];
      const token = queryToken ?? bearer ?? storedCookie?.token;
      const record = runId ? options.tokens.get(runId) : undefined;
      const asset = incoming.pathname === "/styles.css" || incoming.pathname === "/app.js";
      if (
        !runId ||
        (pathRunId !== undefined && pathRunId !== runId) ||
        (!asset && !gatewayPathAllowed(incoming.pathname, runId)) ||
        !token ||
        !record ||
        !verifyRunAccessToken(record, runId, token)
      ) {
        response.statusCode = 404;
        response.end();
        return;
      }
      if (queryToken) {
        if (incoming.pathname !== `/runs/${runId}` || incoming.searchParams.size !== 1) {
          response.statusCode = 404;
          response.end();
          return;
        }
        const maxAge = Math.max(1, Math.floor((Date.parse(record.expiresAt) - Date.now()) / 1_000));
        response.statusCode = 303;
        response.setHeader("location", incoming.pathname);
        response.setHeader(
          "set-cookie",
          `${COOKIE}=${runId}.${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
        );
        response.setHeader("cache-control", "no-store");
        response.setHeader("referrer-policy", "no-referrer");
        response.end();
        return;
      }
      const target = new URL(incoming.pathname + incoming.search, observer);
      const upstream = await fetch(target, {
        method: request.method,
        headers: { accept: request.headers.accept ?? "*/*" },
        redirect: "manual",
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        response.statusCode = 502;
        response.end();
        return;
      }
      response.statusCode = upstream.status;
      upstream.headers.forEach((value, key) => {
        if (
          !["connection", "keep-alive", "set-cookie", "transfer-encoding", "upgrade"].includes(key)
        )
          response.setHeader(key, value);
      });
      if (request.method === "HEAD") response.end();
      else response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      if (!response.headersSent) response.statusCode = 502;
      response.end();
    }
  });
  await new Promise<void>((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.bindHost ?? "127.0.0.1", resolveStart);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("gateway address unavailable");
  return {
    close: async () =>
      new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      ),
    port: () => address.port,
    url: (runId, token) => {
      if (!UUID.test(runId) || !TOKEN.test(token)) throw new Error("gateway URL input invalid");
      const url = new URL(`/runs/${runId}`, publicBase);
      url.searchParams.set("token", token);
      return url.href;
    },
  };
}
