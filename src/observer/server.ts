import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { stateDirectory, statePath } from "../state-directory.js";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { linuxProcessIdentity } from "../controller-lock.js";
import { foldRunStatus, type RunStatusSummary } from "../run-status.js";
import { maquilaRoot } from "../runtime.js";
import { readTelemetry, telemetryPath, type TelemetryRecord } from "../telemetry.js";
import { OBSERVER_CSS, OBSERVER_HTML, OBSERVER_JS } from "./ui.js";
import { OBSERVER_VERSION, record, UUID, validPort, type ObserverDescriptor } from "./shared.js";

const MAX_RUNS = 100;
const MAX_EVENTS = 500;
const MAX_PROMPT_BYTES = 256 * 1024;
const MODEL_ACTORS = new Set(["planner", "worker", "documenter", "reviewer"]);

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
  const dir = statePath(stateDirectory(root), "telemetry");
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
      existsSync(statePath(stateDirectory(root), "controllers", id, "controller-state.json")),
  });
}
function events(root: string, runId: string, after: number, limit: number): TelemetryRecord[] {
  const records = readTelemetry(telemetryPath(root, runId));
  if (records.some((event) => event.runId !== runId)) throw new Error("invalid telemetry");
  return records.filter((event) => event.seq > after).slice(0, limit + 1);
}
export function archivedSystemPrompt(
  root: string,
  runId: string,
  actor: string,
  phaseId: string,
): string {
  if (!UUID.test(runId) || !MODEL_ACTORS.has(actor) || !phaseId || phaseId.length > 200)
    throw new Error("invalid prompt request");
  const runtimePath = statePath(stateDirectory(root), "controllers", runId, "runtime.json");
  const runtime: unknown = JSON.parse(readFileSync(runtimePath, "utf8"));
  if (
    !record(runtime) ||
    Object.keys(runtime).some((key) => !["maquilaSha", "sha256"].includes(key)) ||
    typeof runtime.maquilaSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(runtime.maquilaSha) ||
    typeof runtime.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(runtime.sha256)
  )
    throw new Error("invalid runtime data");
  const source = execFileSync("git", ["show", `${runtime.maquilaSha}:src/agents/${actor}.md`], {
    cwd: maquilaRoot(resolve(import.meta.dirname, "..")),
    encoding: "utf8",
    maxBuffer: MAX_PROMPT_BYTES,
  });
  if (Buffer.byteLength(source) > MAX_PROMPT_BYTES) throw new Error("prompt too large");
  const { body } = parseFrontmatter(source);
  const prompt = body.trim();
  const context = readTelemetry(telemetryPath(root, runId)).find(
    (event) =>
      event.type === "agent_context" && event.actor === actor && event.phase?.id === phaseId,
  );
  if (
    !prompt ||
    context?.type !== "agent_context" ||
    createHash("sha256").update(prompt).digest("hex") !== context.payload.systemPromptSha256
  )
    throw new Error("prompt verification failed");
  return prompt;
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
      const promptMatch = url.pathname.match(
        /^\/api\/v1\/runs\/([0-9a-f-]{36})\/prompts\/(planner|worker|documenter|reviewer)$/,
      );
      if (promptMatch) {
        const runId = promptMatch[1]!;
        const actor = promptMatch[2]!;
        const phaseId = url.searchParams.get("phase") ?? "";
        sendJson(
          response,
          200,
          { version: 1, actor, prompt: archivedSystemPrompt(root, runId, actor, phaseId) },
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
