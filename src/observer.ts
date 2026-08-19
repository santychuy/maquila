import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { externalCommandEnvironment } from "./exe.js";
import { linuxProcessIdentity } from "./controller-lock.js";
import { foldRunStatus, type RunStatusSummary } from "./run-status.js";
import { readTelemetry, telemetryPath, type TelemetryRecord } from "./telemetry.js";
import { OBSERVER_CSS, OBSERVER_HTML, OBSERVER_JS } from "./observer-ui.js";

export const OBSERVER_VERSION = 1;
export const DEFAULT_OBSERVER_PORT = 4600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RUNS = 100;
const MAX_EVENTS = 500;

export interface ObserverDescriptor {
  version: 1;
  instanceId: string;
  pid: number;
  processIdentity?: string;
  port: number;
  url: string;
  startedAt: string;
}
export interface ObserverInfo extends ObserverDescriptor {
  running: true;
}

interface ObserverChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

export interface EnsureObserverOptions {
  root: string;
  cliPath: string;
  port: number;
  env?: NodeJS.ProcessEnv;
  instanceId?: string;
  startupTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  health?: (descriptor: ObserverDescriptor) => Promise<boolean>;
  live?: (pid: number) => boolean;
  identity?: (pid: number) => string | undefined;
  spawnChild?: (
    command: string,
    args: string[],
    options: Parameters<typeof spawn>[2],
  ) => ObserverChild;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}
function live(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return record(error) && error.code !== "ESRCH";
  }
}
export function observerDescriptorPath(root: string): string {
  return resolve(root, ".factory", "observer.json");
}
function observerDir(root: string): string {
  return resolve(root, ".factory", "observer");
}
function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
export function readObserverDescriptor(root: string): ObserverDescriptor | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(observerDescriptorPath(root), "utf8"));
    if (
      record(value) &&
      Object.keys(value).every((key) =>
        ["version", "instanceId", "pid", "processIdentity", "port", "url", "startedAt"].includes(
          key,
        ),
      ) &&
      value.version === 1 &&
      typeof value.instanceId === "string" &&
      UUID.test(value.instanceId) &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      (value.processIdentity === undefined || typeof value.processIdentity === "string") &&
      typeof value.port === "number" &&
      validPort(value.port) &&
      value.url === `http://127.0.0.1:${value.port}` &&
      typeof value.startedAt === "string" &&
      Number.isFinite(Date.parse(value.startedAt))
    )
      return {
        version: 1,
        instanceId: value.instanceId,
        pid: value.pid,
        ...(value.processIdentity ? { processIdentity: value.processIdentity } : {}),
        port: value.port,
        url: value.url,
        startedAt: value.startedAt,
      };
  } catch {}
  return undefined;
}
function writeObserverDescriptor(root: string, descriptor: ObserverDescriptor): void {
  const factory = resolve(root, ".factory");
  ensurePrivateDirectory(factory);
  const target = observerDescriptorPath(root);
  const temporary = `${target}.${process.pid}.${descriptor.instanceId}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(descriptor)}\n`, { mode: 0o600, flag: "wx" });
  try {
    linkSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function removeOwnedDescriptor(root: string, instanceId: string): void {
  if (readObserverDescriptor(root)?.instanceId === instanceId)
    rmSync(observerDescriptorPath(root), { force: true });
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}
function send(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  head = false,
): void {
  response.writeHead(status, securityHeaders(contentType));
  response.end(head ? undefined : body);
}
function sendJson(response: ServerResponse, status: number, value: unknown, head = false): void {
  send(response, status, `${JSON.stringify(value)}\n`, "application/json; charset=utf-8", head);
}
function queryInteger(
  url: URL,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`invalid ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`invalid ${name}`);
  return value;
}
function listRunIds(root: string): string[] {
  const dir = resolve(root, ".factory", "telemetry");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl") && UUID.test(name.slice(0, -6)))
    .map((name) => name.slice(0, -6));
}
function summary(root: string, runId: string): RunStatusSummary {
  return foldRunStatus({
    root,
    runId,
    controllerExists: (id) =>
      existsSync(resolve(root, ".factory", "controllers", id, "controller-state.json")),
  });
}
function events(root: string, runId: string, after: number, limit: number): TelemetryRecord[] {
  const records = readTelemetry(telemetryPath(root, runId));
  if (records.some((event) => event.runId !== runId)) throw new Error("invalid telemetry");
  return records.filter((event) => event.seq > after).slice(0, limit + 1);
}
function allowedHost(request: IncomingMessage, port: number): boolean {
  const host = request.headers.host;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export interface CreateObserverServerOptions {
  root: string;
  port: number;
  instanceId: string;
  hostname?: string;
}
export interface ObserverServer {
  server: Server;
  descriptor: ObserverDescriptor;
  close(): Promise<void>;
}

export async function createObserverServer(
  options: CreateObserverServerOptions,
): Promise<ObserverServer> {
  if (!validPort(options.port) && options.port !== 0) throw new Error("invalid observer port");
  if (!UUID.test(options.instanceId)) throw new Error("invalid observer instance ID");
  const root = resolve(options.root);
  const hostname = options.hostname ?? "127.0.0.1";
  if (hostname !== "127.0.0.1") throw new Error("observer must bind loopback");
  let effectivePort = options.port;
  const server = createServer((request, response) => {
    const head = request.method === "HEAD";
    if (request.method !== "GET" && !head) {
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }
    if (!allowedHost(request, effectivePort)) {
      sendJson(response, 400, { error: "invalid host" }, head);
      return;
    }
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${effectivePort}`);
      if (url.pathname === "/api/v1/health") {
        sendJson(
          response,
          200,
          {
            version: OBSERVER_VERSION,
            ok: true,
            instanceId: options.instanceId,
            pid: process.pid,
            port: effectivePort,
          },
          head,
        );
        return;
      }
      if (url.pathname === "/api/v1/runs") {
        const limit = queryInteger(url, "limit", MAX_RUNS, 1, MAX_RUNS);
        const runs = listRunIds(root)
          .map((runId) => summary(root, runId))
          .toSorted((left, right) =>
            (right.lastActivity ?? "").localeCompare(left.lastActivity ?? ""),
          )
          .slice(0, limit);
        sendJson(response, 200, { version: 1, runs }, head);
        return;
      }
      const eventMatch = url.pathname.match(/^\/api\/v1\/runs\/([0-9a-f-]{36})\/events$/);
      if (eventMatch) {
        const runId = eventMatch[1]!;
        if (!UUID.test(runId)) throw new Error("invalid run ID");
        const after = queryInteger(url, "after", 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = queryInteger(url, "limit", MAX_EVENTS, 1, MAX_EVENTS);
        let found: TelemetryRecord[];
        try {
          found = events(root, runId, after, limit);
        } catch {
          sendJson(
            response,
            200,
            { version: 1, events: [], cursor: after, hasMore: false, integrity: "invalid" },
            head,
          );
          return;
        }
        const page = found.slice(0, limit);
        sendJson(
          response,
          200,
          {
            version: 1,
            events: page,
            cursor: page.at(-1)?.seq ?? after,
            hasMore: found.length > limit,
            integrity: "ok",
          },
          head,
        );
        return;
      }
      const runMatch = url.pathname.match(/^\/api\/v1\/runs\/([0-9a-f-]{36})$/);
      if (runMatch) {
        const runId = runMatch[1]!;
        if (!UUID.test(runId)) throw new Error("invalid run ID");
        sendJson(response, 200, summary(root, runId), head);
        return;
      }
      if (url.pathname === "/styles.css") {
        send(response, 200, OBSERVER_CSS, "text/css; charset=utf-8", head);
        return;
      }
      if (url.pathname === "/app.js") {
        send(response, 200, OBSERVER_JS, "text/javascript; charset=utf-8", head);
        return;
      }
      if (url.pathname === "/" || /^\/runs\/[0-9a-f-]{36}$/.test(url.pathname)) {
        send(response, 200, OBSERVER_HTML, "text/html; charset=utf-8", head);
        return;
      }
      sendJson(response, 404, { error: "not found" }, head);
    } catch {
      sendJson(response, 400, { error: "invalid request" }, head);
    }
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(options.port, hostname, () => {
      server.off("error", reject);
      done();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("observer address unavailable");
  effectivePort = address.port;
  const descriptor: ObserverDescriptor = {
    version: 1,
    instanceId: options.instanceId,
    pid: process.pid,
    ...(linuxProcessIdentity(process.pid)
      ? { processIdentity: linuxProcessIdentity(process.pid) }
      : {}),
    port: effectivePort,
    url: `http://127.0.0.1:${effectivePort}`,
    startedAt: new Date().toISOString(),
  };
  return {
    server,
    descriptor,
    close: () =>
      new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      ),
  };
}

export async function serveObserver(options: CreateObserverServerOptions): Promise<void> {
  const runtime = await createObserverServer(options);
  try {
    writeObserverDescriptor(options.root, runtime.descriptor);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  process.stdout.write(`Observer: ${runtime.descriptor.url}\n`);
  await new Promise<void>((done) => {
    const stop = () => runtime.close().finally(done);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  removeOwnedDescriptor(options.root, options.instanceId);
}

async function healthRequest(descriptor: ObserverDescriptor): Promise<boolean> {
  try {
    const response = await fetch(`${descriptor.url}/api/v1/health`, {
      signal: AbortSignal.timeout(1000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return false;
    const value: unknown = await response.json();
    return (
      record(value) &&
      value.version === OBSERVER_VERSION &&
      value.ok === true &&
      value.instanceId === descriptor.instanceId &&
      value.pid === descriptor.pid &&
      value.port === descriptor.port
    );
  } catch {
    return false;
  }
}

export async function ensureObserver(options: EnsureObserverOptions): Promise<ObserverInfo> {
  const root = resolve(options.root);
  const check = options.health ?? healthRequest;
  const isLive = options.live ?? live;
  const identity = options.identity ?? linuxProcessIdentity;
  const existing = readObserverDescriptor(root);
  if (existing) {
    const healthy = await check(existing);
    if (healthy) {
      if (existing.port !== options.port)
        throw new Error(`observer already running on port ${existing.port}`);
      return { ...existing, running: true };
    }
    if (
      isLive(existing.pid) &&
      (!existing.processIdentity ||
        !identity(existing.pid) ||
        existing.processIdentity === identity(existing.pid))
    )
      throw new Error("observer process is not healthy");
    rmSync(observerDescriptorPath(root), { force: true });
  } else if (existsSync(observerDescriptorPath(root))) {
    throw new Error("observer descriptor is invalid");
  }
  if (!validPort(options.port)) throw new Error("invalid observer port");
  const instanceId = options.instanceId ?? randomUUID();
  if (!UUID.test(instanceId)) throw new Error("invalid observer instance ID");
  const dir = observerDir(root);
  ensurePrivateDirectory(dir);
  const stdout = openSync(resolve(dir, "observer.stdout.log"), "a", 0o600);
  const stderr = openSync(resolve(dir, "observer.stderr.log"), "a", 0o600);
  const child = (
    options.spawnChild ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions))
  )(
    process.execPath,
    [resolve(options.cliPath), "observer", "serve", "--port", String(options.port)],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env: {
        ...externalCommandEnvironment(options.env ?? process.env),
        FACTORY_OBSERVER_INSTANCE_ID: instanceId,
      },
    },
  );
  closeSync(stdout);
  closeSync(stderr);
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  const sleep =
    options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const deadline = Date.now() + (options.startupTimeoutMs ?? 5000);
  while (Date.now() < deadline) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
    const descriptor = readObserverDescriptor(root);
    if (
      descriptor?.instanceId === instanceId &&
      descriptor.pid === child.pid &&
      (await check(descriptor))
    ) {
      child.unref();
      return { ...descriptor, running: true };
    }
    await sleep(25);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const terminateBy = Date.now() + 1000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < terminateBy)
      await sleep(25);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const killBy = Date.now() + 1000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < killBy)
      await sleep(25);
  }
  child.unref();
  if (child.exitCode === null && child.signalCode === null)
    throw new Error("observer termination unconfirmed");
  removeOwnedDescriptor(root, instanceId);
  throw new Error(spawnError ? "observer could not start" : "observer failed readiness check");
}

export async function observerStatus(root: string): Promise<ObserverInfo | undefined> {
  const descriptor = readObserverDescriptor(root);
  return descriptor && (await healthRequest(descriptor))
    ? { ...descriptor, running: true }
    : undefined;
}

export async function stopObserver(
  root: string,
  runtime: {
    health?: (descriptor: ObserverDescriptor) => Promise<boolean>;
    identity?: (pid: number) => string | undefined;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<ObserverDescriptor> {
  const descriptor = readObserverDescriptor(root);
  if (!descriptor) throw new Error("observer is not running");
  if (!(await (runtime.health ?? healthRequest)(descriptor)))
    throw new Error("observer ownership could not be proven");
  const currentIdentity = (runtime.identity ?? linuxProcessIdentity)(descriptor.pid);
  if (
    descriptor.processIdentity &&
    (!currentIdentity || currentIdentity !== descriptor.processIdentity)
  )
    throw new Error("observer ownership could not be proven");
  (runtime.kill ?? ((pid, signal) => process.kill(pid, signal)))(descriptor.pid, "SIGTERM");
  const sleep =
    runtime.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!existsSync(observerDescriptorPath(root))) return descriptor;
    await sleep(25);
  }
  throw new Error("observer did not stop");
}
