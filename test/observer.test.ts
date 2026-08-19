import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  createObserverServer,
  ensureObserver,
  observerDescriptorPath,
  stopObserver,
  type ObserverDescriptor,
} from "../src/observer.js";
import { OBSERVER_CSS, OBSERVER_JS } from "../src/observer-ui.js";
import { createTelemetryWriter, telemetryPath } from "../src/telemetry.js";

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
    const script = await raw(port, "GET", "/app.js");
    assert.match(script.body, /textContent/);
    assert.match(script.body, /after='\+eventCursor/);
    assert.doesNotMatch(script.body, /innerHTML/);
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

test("observer UI preserves focus and truthful partial telemetry state", () => {
  const script = OBSERVER_JS;
  assert.match(script, /snapshot===runsSnapshot/);
  assert.match(script, /contains\(document\.activeElement\)/);
  assert.match(script, /focusout/);
  assert.match(script, /el\.textContent!==next/);
  assert.match(script, /Telemetry events unavailable/);
  assert.match(script, /Latest actor or open tool/);
  assert.match(script, /detail\.pullRequest/);
  assert.match(script, /noopener noreferrer/);
  assert.match(OBSERVER_CSS, /\.event-actor,\.event-detail\{grid-column:2/);
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
