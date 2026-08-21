import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  archivedSystemPrompt,
  createObserverServer,
  ensureObserver,
  observerDescriptorPath,
  stopObserver,
  type ObserverDescriptor,
} from "../src/observer.js";
import { OBSERVER_CSS, OBSERVER_HTML, OBSERVER_JS } from "../src/observer-ui.js";
import {
  formatDuration,
  formatRelativeTime,
  formatTimestamp,
  formatTokens,
  sumReportedCosts,
} from "../src/observer-app.js";
import { parseAgentDefinition } from "../src/agents/index.js";
import { createTelemetryWriter, telemetryPath } from "../src/telemetry.js";

const observerAppSource = readFileSync(resolve(process.cwd(), "src", "observer-app.tsx"), "utf8");

const runId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";

function descriptor(root: string, overrides: Partial<ObserverDescriptor> = {}): ObserverDescriptor {
  return {
    version: 1,
    instanceId,
    pid: 1234,
    processIdentity: "boot:1",
    port: 4600,
    url: "http://127.0.0.1:4600",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}
function writeDescriptor(root: string, value: ObserverDescriptor): void {
  mkdirSync(resolve(root, ".factory"), { recursive: true, mode: 0o700 });
  writeFileSync(observerDescriptorPath(root), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
async function malformedTarget(port: number): Promise<string> {
  return new Promise((done, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(
        `GET http://[::1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (response += chunk));
    socket.on("end", () => done(response));
    socket.on("error", reject);
  });
}

async function raw(
  port: number,
  method: string,
  path: string,
  host = `127.0.0.1:${port}`,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((done, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, method, headers: { host } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          done({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("observer serves loopback-only read-only API and accessible static UI", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-observer-"));
  const writer = createTelemetryWriter(root, runId);
  writer.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
  writer.append({
    type: "phase_started",
    actor: "planner",
    phase: { id: "planning:1", name: "planning", attempt: 1 },
    payload: {},
  });
  writer.append({
    type: "tool_started",
    actor: "planner",
    phase: { id: "planning:1", name: "planning", attempt: 1 },
    payload: { toolName: "read", toolCallId: "tool-1" },
  });
  const observer = await createObserverServer({ root, port: 0, instanceId });
  const { port } = observer.descriptor;
  try {
    const health = await raw(port, "GET", "/api/v1/health");
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).instanceId, instanceId);
    assert.match(String(health.headers["content-security-policy"]), /default-src 'self'/);
    assert.equal(health.headers["access-control-allow-origin"], undefined);
    assert.equal(health.headers["cache-control"], "no-store");

    const runs = await raw(port, "GET", "/api/v1/runs?limit=10");
    assert.equal(JSON.parse(runs.body).runs[0].runId, runId);
    const detail = await raw(port, "GET", `/api/v1/runs/${runId}`);
    assert.equal(JSON.parse(detail.body).currentTool, "read");
    const page = await raw(port, "GET", `/api/v1/runs/${runId}/events?after=1&limit=1`);
    assert.equal(JSON.parse(page.body).events[0].seq, 2);
    assert.equal(JSON.parse(page.body).hasMore, true);

    const html = await raw(port, "GET", `/runs/${runId}`);
    assert.match(html.body, /aria-live="polite"/);
    assert.match(html.body, /aria-busy="true"/);
    assert.match(html.body, /<script type="module" src="\/app\.js"><\/script>/);
    const script = await raw(port, "GET", "/app.js");
    assert.match(script.body, /textContent/);
    assert.match(script.body, /events\?after=/);
    assert.doesNotMatch(observerAppSource, /innerHTML/);
    assert.equal((await raw(port, "HEAD", "/")).body, "");
    assert.equal((await raw(port, "POST", "/api/v1/runs")).status, 405);
    assert.equal((await raw(port, "GET", "/api/v1/runs", "evil.example")).status, 400);
    assert.equal((await raw(port, "GET", "/../../etc/passwd")).status, 404);
    assert.equal((await raw(port, "GET", "/api/v1/runs?limit=1000")).status, 400);
    assert.match(await malformedTarget(port), /^HTTP\/1\.1 400/);
    assert.equal((await raw(port, "GET", "/api/v1/health")).status, 200);
  } finally {
    await observer.close();
    writer.append({ type: "heartbeat", actor: "controller", payload: {} });
    assert.equal(
      readFileSync(telemetryPath(root, runId), "utf8").split("\n").filter(Boolean).length,
      4,
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test("archived prompt retrieval binds run, actor, Factory SHA, and telemetry fingerprint", () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-observer-prompt-"));
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const planner = parseAgentDefinition(
      execFileSync("git", ["show", `${sha}:src/agents/planner.md`], { encoding: "utf8" }),
      "src/agents/planner.md",
    );
    mkdirSync(resolve(root, ".factory", "controllers", runId), { recursive: true });
    writeFileSync(
      resolve(root, ".factory", "controllers", runId, "runtime.json"),
      JSON.stringify({ factorySha: sha, sha256: "0".repeat(64) }),
    );
    const writer = createTelemetryWriter(root, runId);
    writer.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    writer.append({
      type: "phase_started",
      actor: "planner",
      phase: { id: "planning:1", name: "planning", attempt: 1 },
      payload: {},
    });
    writer.append({
      type: "agent_context",
      actor: "planner",
      phase: { id: "planning:1", name: "planning", attempt: 1 },
      payload: {
        model: planner.model,
        description: planner.description,
        tools: planner.tools,
        thinking: planner.thinking,
        access: planner.access,
        systemPromptSha256: createHash("sha256").update(planner.systemPrompt).digest("hex"),
      },
    });
    assert.equal(archivedSystemPrompt(root, runId, "planner"), planner.systemPrompt);
    assert.throws(() => archivedSystemPrompt(root, runId, "controller"), /invalid prompt request/);
    const runtimePath = resolve(root, ".factory", "controllers", runId, "runtime.json");
    for (const runtime of [
      { factorySha: sha, extra: true },
      { factorySha: sha },
      { factorySha: sha, sha256: "not-a-hash" },
      { factorySha: sha, sha256: "A".repeat(64) },
    ]) {
      writeFileSync(runtimePath, JSON.stringify(runtime));
      assert.throws(() => archivedSystemPrompt(root, runId, "planner"), /invalid runtime data/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observer replay tolerates partial tail and reports malformed telemetry safely", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-observer-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    writer.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    writeFileSync(telemetryPath(root, runId), '{"partial":', { flag: "a" });
    const invalidId = "33333333-3333-4333-8333-333333333333";
    writeFileSync(telemetryPath(root, invalidId), "not-json\n", { mode: 0o600 });
    const observer = await createObserverServer({ root, port: 0, instanceId });
    try {
      const response = await raw(observer.descriptor.port, "GET", "/api/v1/runs?limit=10");
      const runs = JSON.parse(response.body).runs as Array<{ runId: string; status: string }>;
      assert.equal(runs.find((run) => run.runId === runId)?.status, "running");
      assert.equal(runs.find((run) => run.runId === invalidId)?.status, "invalid");
      const detail = await raw(observer.descriptor.port, "GET", `/api/v1/runs/${invalidId}`);
      assert.equal(JSON.parse(detail.body).status, "invalid");
      const events = await raw(
        observer.descriptor.port,
        "GET",
        `/api/v1/runs/${invalidId}/events?after=0&limit=10`,
      );
      assert.equal(events.status, 200);
      assert.equal(JSON.parse(events.body).integrity, "invalid");
      assert.deepEqual(JSON.parse(events.body).events, []);
    } finally {
      await observer.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observer ensure reuses healthy owner and starts after stale descriptor", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-observer-"));
  try {
    const current = descriptor(root);
    writeDescriptor(root, current);
    let spawned = false;
    await assert.rejects(
      ensureObserver({
        root,
        cliPath: "/tmp/cli.js",
        port: 4700,
        health: async () => true,
      }),
      /already running on port 4600/,
    );
    const reused = await ensureObserver({
      root,
      cliPath: "/tmp/cli.js",
      port: 4600,
      health: async () => true,
      spawnChild: () => {
        spawned = true;
        throw new Error("unexpected spawn");
      },
    });
    assert.equal(reused.instanceId, instanceId);
    assert.equal(spawned, false);

    rmSync(observerDescriptorPath(root));
    writeDescriptor(
      root,
      descriptor(root, {
        pid: 12,
        processIdentity: "old",
        port: 4699,
        url: "http://127.0.0.1:4699",
      }),
    );
    const nextId = "44444444-4444-4444-8444-444444444444";
    const started = await ensureObserver({
      root,
      cliPath: "/tmp/cli.js",
      port: 4600,
      instanceId: nextId,
      live: () => false,
      health: async (value) => value.instanceId === nextId,
      spawnChild: (_command, _args, options) => {
        const value = descriptor(root, {
          instanceId: nextId,
          pid: 4321,
          processIdentity: "new",
        });
        writeDescriptor(root, value);
        assert.equal(options.detached, true);
        return {
          pid: 4321,
          exitCode: null,
          signalCode: null,
          kill: () => true,
          once: () => {},
          unref: () => {},
        };
      },
      sleep: async () => {},
    });
    assert.equal(started.instanceId, nextId);
    assert.equal(started.port, 4600);
    assert.equal(statSync(observerDescriptorPath(root)).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observer UI preserves accessible safe rendering intent", () => {
  assert.match(OBSERVER_HTML, /Phase sequence/);
  assert.match(OBSERVER_HTML, /<details class="raw-events">/);
  assert.match(OBSERVER_JS, /aria-expanded/);
  assert.match(observerAppSource, /aria-controls=\{selected \? ids\.detail : undefined\}/);
  assert.match(observerAppSource, /aria-current=\{status === "running" \? "step" : undefined\}/);
  assert.match(OBSERVER_JS, /System prompt/);
  assert.doesNotMatch(OBSERVER_JS, /scrollIntoView/);
  assert.match(
    OBSERVER_HTML,
    /<ol id="timeline" class="phase-timeline"[^>]+aria-describedby="timeline-note">/,
  );
  assert.match(OBSERVER_HTML, /Loading phase telemetry…/);
  assert.doesNotMatch(OBSERVER_HTML, /id="segment-detail"/);
  assert.doesNotMatch(OBSERVER_JS, /Latest actor or open tool/);
  assert.doesNotMatch(OBSERVER_HTML, /Width encodes elapsed time/);
  assert.match(observerAppSource, /type="button"/);
  assert.match(observerAppSource, /while \(page\.hasMore\)/);
  assert.match(observerAppSource, /interrupted at run end/);
  assert.match(observerAppSource, /reportedCostNanoUsd/);
  assert.match(observerAppSource, /group\.count > 1/);
  assert.match(observerAppSource, /key=\{segment\.id\}/);
  assert.match(observerAppSource, /Loading archived prompt/);
  assert.match(observerAppSource, /delete output\.dataset\.loading/);
  assert.match(observerAppSource, /segment\.boundary \? "interrupted" : "running"/);
  assert.match(observerAppSource, /previous error/);
  assert.doesNotMatch(observerAppSource, /Prompt fingerprint/);
  assert.doesNotMatch(observerAppSource, /Unavailable by design/);
  assert.match(observerAppSource, /preventScroll: true/);
  assert.match(observerAppSource, /segments\(events\)\.toReversed\(\)/);
  assert.match(
    observerAppSource,
    /selectedSegmentId = segment\.id === selectedSegmentId \? null : segment\.id/,
  );
  assert.doesNotMatch(observerAppSource, /findLast\(\(segment\) => !segment\.boundary\)/);
  assert.match(observerAppSource, /formatRelativeTime\(segment\.start\.recordedAt\)/);
  assert.match(observerAppSource, /formatTimestamp\(segment\.start\.recordedAt\)/);
  assert.match(observerAppSource, /type PhaseKind = "agent" \| "code" \| "engineer"/);
  assert.match(observerAppSource, /aria-label=\{`\$\{kind\} phase`\}/);
  assert.match(observerAppSource, /class="phase-chevron"/);
  assert.match(observerAppSource, /\{selected && \(/);
  assert.match(observerAppSource, /role="region" aria-labelledby=\{ids\.button\}/);
  assert.match(observerAppSource, /phaseStatus\(segment\)\.replaceAll\("_", " "\)/);
  assert.match(observerAppSource, /segment\.start\.phase\.attempt > 1/);
  assert.match(observerAppSource, /No phase telemetry recorded yet\.<\/li>/);
  assert.doesNotMatch(observerAppSource, /style=\{\{ width:/);
  assert.doesNotMatch(observerAppSource, /innerHTML/);
  assert.doesNotMatch(observerAppSource, /Date\.now\(\)/);
});

test("observer UI preserves focus and truthful partial telemetry state", () => {
  assert.match(observerAppSource, /snapshot === runsSnapshot/);
  assert.match(observerAppSource, /if \(!runsSnapshot\) host\.replaceChildren\(\)/);
  assert.match(observerAppSource, /contains\(document\.activeElement\)/);
  assert.match(observerAppSource, /focusout/);
  assert.match(observerAppSource, /element\.textContent !== next/);
  assert.match(OBSERVER_JS, /Telemetry events unavailable/);
  assert.match(observerAppSource, /detail\.pullRequest/);
  assert.match(observerAppSource, /Engineer decision required/);
  assert.match(observerAppSource, /Reply in Linear/);
  assert.match(observerAppSource, /noopener noreferrer/);
  assert.match(OBSERVER_CSS, /grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(OBSERVER_CSS, /\.phase-timeline:before/);
  assert.match(OBSERVER_CSS, /\.segment\[aria-expanded=true\]/);
  assert.match(OBSERVER_CSS, /\.segment\[aria-current=step\]/);
  assert.match(OBSERVER_CSS, /\.segment\{[^}]+border:0[^}]+background:transparent/);
  assert.match(OBSERVER_CSS, /\.segment-detail\{[^}]+background:transparent/);
  assert.match(OBSERVER_CSS, /\.phase-node\.agent/);
  assert.match(OBSERVER_CSS, /\.phase-node\.engineer/);
  assert.match(OBSERVER_CSS, /\.phase-chevron/);
  assert.match(OBSERVER_CSS, /\.segment\{[^}]+overflow-wrap:anywhere/);
  assert.match(OBSERVER_CSS, /\.segment-detail dl\{grid-template-columns:1fr/);
  assert.doesNotMatch(OBSERVER_CSS, /overflow-x:auto/);
  assert.match(OBSERVER_CSS, /\.event-actor,\.event-detail\{grid-column:2/);
  assert.deepEqual([999, 1_000, 12_400, 1_000_000].map(formatTokens), ["999", "1K", "12.4K", "1M"]);
  assert.deepEqual([null, 0, 46_999, 60_000, 106_000].map(formatDuration), [
    "—",
    "0s",
    "46s",
    "1m 0s",
    "1m 46s",
  ]);
  assert.equal(sumReportedCosts([154_518_890, undefined, 1_359_636_000]), 1_514_154_890);
  assert.equal(sumReportedCosts([undefined]), undefined);
  assert.equal(formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString()), "5 min ago");
  const stamped = formatTimestamp("2026-04-01T13:14:00.000Z");
  assert.match(stamped, /2026/);
  assert.doesNotMatch(stamped, / · |UTC|GMT|CST|PST|EST|timeZone|America\//);
  assert.doesNotMatch(observerAppSource, /resolvedOptions\(\)\.timeZone/);
  assert.equal(formatTimestamp("invalid"), "—");
  assert.match(observerAppSource, /formatDuration\(Math\.max\(0, elapsed\)\)/);
  assert.doesNotMatch(observerAppSource, /label="Elapsed"/);
  assert.match(observerAppSource, /label="Total reported cost"/);
});

test("observer readiness failure terminates owned child before rejection", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-observer-"));
  try {
    let signalCode: NodeJS.Signals | null = null;
    let unrefed = false;
    await assert.rejects(
      ensureObserver({
        root,
        cliPath: "/tmp/cli.js",
        port: 4600,
        instanceId,
        startupTimeoutMs: 0,
        sleep: async () => {},
        spawnChild: () => ({
          pid: 7654,
          exitCode: null,
          get signalCode() {
            return signalCode;
          },
          kill: (signal = "SIGTERM") => {
            signalCode = signal;
            return true;
          },
          once: () => {},
          unref: () => {
            unrefed = true;
          },
        }),
      }),
      /readiness/,
    );
    assert.equal(signalCode, "SIGTERM");
    assert.equal(unrefed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observer stop requires matching health and process identity", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-observer-"));
  try {
    const value = descriptor(root);
    writeDescriptor(root, value);
    let killed = false;
    await assert.rejects(
      stopObserver(root, {
        health: async () => true,
        identity: () => "other",
        kill: () => {
          killed = true;
        },
      }),
      /ownership/,
    );
    assert.equal(killed, false);
    const stopped = await stopObserver(root, {
      health: async () => true,
      identity: () => "boot:1",
      kill: (_pid, signal) => {
        assert.equal(signal, "SIGTERM");
        rmSync(observerDescriptorPath(root));
        killed = true;
      },
      sleep: async () => {},
    });
    assert.equal(stopped.instanceId, instanceId);
    assert.equal(killed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observer refuses a non-loopback bind and occupied port", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-observer-"));
  const first = await createObserverServer({ root, port: 0, instanceId });
  try {
    await assert.rejects(
      createObserverServer({
        root,
        port: first.descriptor.port,
        instanceId: "55555555-5555-4555-8555-555555555555",
      }),
      /EADDRINUSE/,
    );
    await assert.rejects(
      createObserverServer({ root, port: 4600, instanceId, hostname: "0.0.0.0" }),
      /loopback/,
    );
  } finally {
    await first.close();
    rmSync(root, { recursive: true, force: true });
  }
});
