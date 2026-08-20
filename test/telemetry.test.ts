import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createTelemetryWriter,
  MAX_TELEMETRY_FILE_BYTES,
  parseTelemetryRecord,
  readTelemetry,
  sanitizeTelemetryText,
  telemetryPath,
} from "../src/telemetry.js";

const runId = "11111111-1111-1111-1111-111111111111";

function record(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    runId,
    seq: 1,
    eventId: `${runId}:1`,
    type: "run_created",
    recordedAt: new Date(0).toISOString(),
    actor: "controller",
    payload: { status: "created" },
    ...overrides,
  };
}

test("telemetry schema rejects unknown fields and inconsistent identity", () => {
  assert.throws(() => parseTelemetryRecord(record({ secret: "nope" })), /invalid telemetry/);
  assert.throws(() => parseTelemetryRecord(record({ eventId: `${runId}:2` })), /eventId/);
  assert.throws(
    () =>
      parseTelemetryRecord(
        record({ type: "tool_started", payload: { toolName: "bash", toolCallId: "1", args: [] } }),
      ),
    /invalid telemetry/,
  );
  assert.throws(
    () =>
      parseTelemetryRecord(
        record({ type: "phase_finished", actor: "planner", payload: { status: "completed" } }),
      ),
    /requires phase/,
  );
  assert.throws(
    () => parseTelemetryRecord(record({ type: "agent_started", actor: "planner", payload: {} })),
    /requires phase/,
  );
  assert.throws(
    () =>
      parseTelemetryRecord(
        record({
          type: "tool_started",
          actor: "worker",
          payload: { toolName: "edit", toolCallId: "1" },
        }),
      ),
    /requires phase/,
  );
});

test("agent context and usage are strict, ordered, and prompt/cost free", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-telemetry-agent-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    const phase = { id: "planning:1", name: "planning" as const, attempt: 1 };
    writer.append({ type: "phase_started", actor: "planner", phase, payload: {} });
    const context = {
      model: "provider/model",
      description: "Plans changes",
      tools: ["read"],
      thinking: "high" as const,
      access: "read-only" as const,
      systemPromptSha256: "a".repeat(64),
    };
    assert.throws(
      () =>
        writer.append({
          type: "agent_usage",
          actor: "planner",
          phase,
          payload: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        }),
      /before context/,
    );
    writer.append({ type: "agent_context", actor: "planner", phase, payload: context });
    assert.throws(
      () =>
        writer.append({
          type: "agent_usage",
          actor: "planner",
          phase,
          payload: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        }),
      /completed activity/,
    );
    writer.append({ type: "agent_started", actor: "planner", phase, payload: {} });
    assert.throws(
      () =>
        writer.append({
          type: "agent_finished",
          actor: "worker",
          phase: { ...phase, name: "implementing" },
          payload: { status: "completed" },
        }),
      /matching phase/,
    );
    assert.throws(
      () =>
        writer.append({
          type: "agent_finished",
          actor: "planner",
          phase: { ...phase, attempt: 2 },
          payload: { status: "completed" },
        }),
      /matching phase/,
    );
    writer.append({
      type: "agent_finished",
      actor: "planner",
      phase,
      payload: { status: "completed" },
    });
    writer.append({
      type: "agent_usage",
      actor: "planner",
      phase,
      payload: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    });
    assert.throws(
      () => writer.append({ type: "agent_context", actor: "planner", phase, payload: context }),
      /duplicate/,
    );
    assert.throws(
      () =>
        parseTelemetryRecord(
          record({
            type: "agent_context",
            actor: "planner",
            phase,
            payload: { ...context, prompt: "secret" },
          }),
        ),
      /invalid telemetry/,
    );
    assert.throws(
      () =>
        parseTelemetryRecord(
          record({
            type: "agent_usage",
            actor: "planner",
            phase,
            payload: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 },
          }),
        ),
      /invalid telemetry/,
    );
    assert.throws(
      () =>
        writer.append({
          type: "tool_started",
          actor: "planner",
          phase,
          payload: { toolName: "read", toolCallId: "late" },
        }),
      /after usage/,
    );
    assert.equal(readTelemetry(writer.path).at(-1)?.type, "agent_usage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("phase closure must match active actor and full phase identity", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-telemetry-phase-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    const phase = { id: "planning:1", name: "planning" as const, attempt: 1 };
    writer.append({ type: "phase_started", actor: "planner", phase, payload: {} });
    assert.throws(
      () =>
        writer.append({
          type: "phase_finished",
          actor: "worker",
          phase: { ...phase, name: "implementing" },
          payload: { status: "completed" },
        }),
      /does not match/,
    );
    assert.throws(
      () =>
        writer.append({
          type: "phase_finished",
          actor: "planner",
          phase: { ...phase, attempt: 2 },
          payload: { status: "completed" },
        }),
      /does not match/,
    );
    writer.append({
      type: "phase_finished",
      actor: "planner",
      phase,
      payload: { status: "failed" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay rejects reuse of a closed phase ID", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-telemetry-phase-reuse-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    const phase = { id: "planning:1", name: "planning" as const, attempt: 1 };
    const started = writer.append({
      type: "phase_started",
      actor: "planner",
      phase,
      payload: {},
    });
    writer.append({
      type: "phase_finished",
      actor: "planner",
      phase,
      payload: { status: "failed" },
    });
    appendFileSync(
      writer.path,
      `${JSON.stringify({ ...started, seq: 3, eventId: `${runId}:3` })}\n`,
    );
    assert.throws(() => readTelemetry(writer.path), /duplicate phase start/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writer assigns gap-free sequence across reopen and replay ignores partial tail", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-telemetry-"));
  try {
    const first = createTelemetryWriter(root, runId);
    assert.equal(
      first.append({ type: "run_created", actor: "controller", payload: { status: "created" } })
        .seq,
      1,
    );
    const second = createTelemetryWriter(root, runId);
    assert.equal(
      second.append({
        type: "failure",
        actor: "controller",
        payload: { stage: "unicode", message: "café 🚀" },
      }).seq,
      2,
    );
    appendFileSync(second.path, '{"partial":');
    assert.deepEqual(
      readTelemetry(second.path).map((event) => event.seq),
      [1, 2],
    );
    const third = createTelemetryWriter(root, runId);
    assert.equal(
      third.append({ type: "run_started", actor: "controller", payload: { status: "running" } })
        .seq,
      3,
    );
    assert.deepEqual(
      readTelemetry(third.path).map((event) => event.seq),
      [1, 2, 3],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal telemetry permits only later cleanup reconciliation", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-telemetry-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    writer.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    writer.append({
      type: "run_finished",
      actor: "controller",
      payload: { status: "failed", cleanup: "failed" },
    });
    const reopened = createTelemetryWriter(root, runId);
    reopened.append({
      type: "cleanup_updated",
      actor: "controller",
      payload: { cleanup: "complete" },
    });
    assert.throws(
      () =>
        reopened.append({
          type: "cleanup_updated",
          actor: "controller",
          payload: { cleanup: "complete" },
        }),
      /already terminal/,
    );
    assert.throws(
      () =>
        reopened.append({
          type: "failure",
          actor: "controller",
          payload: { stage: "x", message: "x" },
        }),
      /already terminal/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay rejects a complete sequence gap", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-telemetry-"));
  const path = telemetryPath(root, runId);
  try {
    const writer = createTelemetryWriter(root, runId);
    writer.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...value, seq: 2, eventId: `${runId}:2` })}\n`);
    assert.throws(() => readTelemetry(path), /gap-free/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful telemetry requires cleanup and publication metadata is strict", () => {
  for (const status of ["ready_for_publication", "completed"]) {
    assert.throws(
      () =>
        parseTelemetryRecord(
          record({
            type: "run_finished",
            payload: { status, cleanup: "failed" },
          }),
        ),
      /requires cleanup/,
    );
  }
  assert.doesNotThrow(() =>
    parseTelemetryRecord(
      record({
        type: "publication_completed",
        payload: {
          number: 42,
          url: "https://github.com/santychuy/bookbounce/pull/42",
          branch: "factory/riff-40-aaaaaaaaaaaa",
          commitSha: "b".repeat(40),
        },
      }),
    ),
  );
  assert.throws(
    () =>
      parseTelemetryRecord(
        record({
          type: "publication_completed",
          payload: {
            number: 42,
            url: "https://evil.example/pull/42",
            branch: "factory/riff-40-aaaaaaaaaaaa",
            commitSha: "b".repeat(40),
          },
        }),
      ),
    /invalid telemetry/,
  );
  for (const name of [".", "..", "bad/path", "bad\\path", "bad\0name"])
    assert.throws(
      () =>
        parseTelemetryRecord(record({ type: "artifact_available", payload: { name, size: 1 } })),
      /artifact name|invalid telemetry/,
    );
});

test("telemetry ledger rejects aggregate size overflow before replay and append", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-telemetry-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    writer.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    truncateSync(writer.path, MAX_TELEMETRY_FILE_BYTES);
    assert.throws(
      () => writer.append({ type: "heartbeat", actor: "controller", payload: {} }),
      /file exceeds limit/,
    );
    truncateSync(writer.path, MAX_TELEMETRY_FILE_BYTES + 1);
    assert.throws(() => readTelemetry(writer.path), /file exceeds limit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("telemetry failure text redacts longest overlapping secrets and control characters", () => {
  assert.equal(sanitizeTelemetryText("bad\nabcdef", ["abc", "abcdef"]), "bad [REDACTED]");
});
