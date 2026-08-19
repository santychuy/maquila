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

test("ready telemetry requires cleanup and artifact names are safe", () => {
  assert.throws(
    () =>
      parseTelemetryRecord(
        record({
          type: "run_finished",
          payload: { status: "ready_for_publication", cleanup: "failed" },
        }),
      ),
    /requires cleanup/,
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
