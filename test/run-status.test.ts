import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { foldRunStatus } from "../src/run-status.js";
import { createTelemetryWriter, telemetryPath } from "../src/telemetry.js";

const runId = "11111111-1111-4111-8111-111111111111";

function temporary(): string {
  return mkdtempSync(resolve(tmpdir(), "factory-status-"));
}

test("status folds safe live activity and terminal evidence", () => {
  const root = temporary();
  try {
    const telemetry = createTelemetryWriter(root, runId);
    telemetry.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    telemetry.append({
      type: "phase_started",
      actor: "worker",
      phase: { id: "implementing:1", name: "implementing", attempt: 1 },
      payload: {},
    });
    telemetry.append({
      type: "tool_started",
      actor: "worker",
      phase: { id: "implementing:1", name: "implementing", attempt: 1 },
      payload: { toolName: "edit", toolCallId: "tool-1" },
    });
    const live = foldRunStatus({ root, runId, now: Date.now() });
    assert.equal(live.status, "running");
    assert.equal(live.phase, "implementing");
    assert.equal(live.currentTool, "edit");
    assert.ok(live.runtimeMilliseconds !== null);
    assert.ok(live.phaseRuntimeMilliseconds !== null);

    telemetry.append({
      type: "tool_finished",
      actor: "worker",
      phase: { id: "implementing:1", name: "implementing", attempt: 1 },
      payload: { toolName: "edit", toolCallId: "tool-1", isError: false },
    });
    telemetry.append({
      type: "agent_finished",
      actor: "worker",
      phase: { id: "implementing:1", name: "implementing", attempt: 1 },
      payload: { status: "completed" },
    });
    const idle = foldRunStatus({ root, runId, now: Date.now() });
    assert.equal(idle.actor, null);
    assert.equal(idle.currentTool, null);
    telemetry.append({
      type: "artifact_available",
      actor: "controller",
      payload: { name: "change.patch", size: 42, sha256: "a".repeat(64) },
    });
    telemetry.append({
      type: "cleanup_updated",
      actor: "controller",
      payload: { cleanup: "complete" },
    });
    telemetry.append({
      type: "publication_completed",
      actor: "controller",
      payload: {
        number: 42,
        url: "https://github.com/santychuy/bookbounce/pull/42",
        branch: "factory/riff-40-aaaaaaaaaaaa",
        commitSha: "b".repeat(40),
      },
    });
    telemetry.append({
      type: "run_finished",
      actor: "controller",
      payload: { status: "completed", cleanup: "complete" },
    });
    const done = foldRunStatus({ root, runId });
    assert.equal(done.status, "completed");
    assert.equal(done.currentTool, null);
    assert.equal(done.cleanup, "complete");
    assert.ok(done.runtimeMilliseconds !== null);
    assert.equal(done.phaseRuntimeMilliseconds, null);
    assert.equal(done.artifacts[0]?.name, "change.patch");
    assert.equal(done.pullRequest?.url, "https://github.com/santychuy/bookbounce/pull/42");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status preserves the primary failure when evidence collection also fails", () => {
  const root = temporary();
  try {
    const telemetry = createTelemetryWriter(root, runId);
    telemetry.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    telemetry.append({
      type: "failure",
      actor: "controller",
      payload: { stage: "planner", message: "controller stage failed" },
    });
    telemetry.append({
      type: "failure",
      actor: "controller",
      payload: { stage: "failure_evidence", message: "failure evidence unavailable" },
    });
    telemetry.append({
      type: "run_finished",
      actor: "controller",
      payload: { status: "failed", cleanup: "complete" },
    });

    assert.deepEqual(foldRunStatus({ root, runId }).failure, {
      code: "planner",
      message: "controller stage failed",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status distinguishes stale, unknown, legacy, and malformed telemetry", () => {
  const root = temporary();
  try {
    assert.equal(foldRunStatus({ root, runId }).status, "unknown");
    assert.equal(foldRunStatus({ root, runId, controllerExists: () => true }).status, "legacy");
    const telemetry = createTelemetryWriter(root, runId);
    telemetry.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    assert.equal(
      foldRunStatus({ root, runId, now: Date.now() + 60_000, staleAfterMs: 1 }).status,
      "activity_unknown",
    );
    writeFileSync(telemetryPath(root, runId), "{bad}\n");
    const invalid = foldRunStatus({ root, runId });
    assert.equal(invalid.status, "invalid");
    assert.equal(invalid.failure?.code, "telemetry_invalid");
    assert.doesNotMatch(JSON.stringify(invalid), /\{bad\}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status rejects a valid ledger copied under another run ID", () => {
  const root = temporary();
  const otherRunId = "22222222-2222-4222-8222-222222222222";
  try {
    const source = createTelemetryWriter(root, runId);
    source.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    const copied = createTelemetryWriter(root, otherRunId);
    writeFileSync(copied.path, readFileSync(source.path));
    const result = foldRunStatus({ root, runId: otherRunId });
    assert.equal(result.status, "invalid");
    assert.equal(result.failure?.code, "telemetry_invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status ignores an incomplete trailing event", () => {
  const root = temporary();
  try {
    const telemetry = createTelemetryWriter(root, runId);
    telemetry.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    writeFileSync(telemetry.path, `${readFileSync(telemetry.path, "utf8")}{"partial"`);
    assert.equal(foldRunStatus({ root, runId, now: Date.now() }).status, "running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
