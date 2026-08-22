import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { foldRunStatus } from "../src/run-status.js";
import { createTelemetryWriter, telemetryPath } from "../src/telemetry.js";

const runId = "11111111-1111-4111-8111-111111111111";

function temporary(): string {
  return mkdtempSync(resolve(tmpdir(), "maquila-status-"));
}

const agentContext = {
  model: "provider/model",
  description: "Workflow agent",
  tools: ["read"],
  thinking: "high" as const,
  access: "read-only" as const,
  systemPromptSha256: "a".repeat(64),
};

function completePlan(telemetry: ReturnType<typeof createTelemetryWriter>): void {
  const phase = { id: "plan:1", name: "planning" as const, stepId: "plan" as const, attempt: 1 };
  telemetry.append({ type: "phase_started", actor: "planner", phase, payload: {} });
  telemetry.append({ type: "agent_context", actor: "planner", phase, payload: agentContext });
  telemetry.append({ type: "agent_started", actor: "planner", phase, payload: {} });
  telemetry.append({
    type: "agent_finished",
    actor: "planner",
    phase,
    payload: { status: "completed" },
  });
  telemetry.append({
    type: "agent_usage",
    actor: "planner",
    phase,
    payload: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  });
  telemetry.append({
    type: "phase_finished",
    actor: "planner",
    phase,
    payload: { status: "completed" },
  });
}

function completeReview(telemetry: ReturnType<typeof createTelemetryWriter>): void {
  const phase = {
    id: "review:1",
    name: "reviewing" as const,
    stepId: "review" as const,
    attempt: 1,
  };
  telemetry.append({ type: "phase_started", actor: "reviewer", phase, payload: {} });
  telemetry.append({ type: "agent_context", actor: "reviewer", phase, payload: agentContext });
  telemetry.append({ type: "agent_started", actor: "reviewer", phase, payload: {} });
  telemetry.append({
    type: "agent_finished",
    actor: "reviewer",
    phase,
    payload: { status: "completed" },
  });
  telemetry.append({
    type: "agent_usage",
    actor: "reviewer",
    phase,
    payload: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  });
  telemetry.append({
    type: "phase_finished",
    actor: "reviewer",
    phase,
    payload: { status: "completed" },
  });
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
      type: "agent_started",
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
    assert.equal(live.currentStepId, null);
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
        branch: "maquila/riff-40-aaaaaaaaaaaa",
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
    assert.equal(done.currentStepId, null);
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

test("status retains plan through a decision wait and advances at the next workflow step", () => {
  const root = temporary();
  try {
    const telemetry = createTelemetryWriter(root, runId);
    telemetry.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    completePlan(telemetry);
    const waitingPhase = {
      id: "awaiting_decision:1",
      name: "awaiting_decision" as const,
      attempt: 1,
    };
    telemetry.append({
      type: "phase_started",
      actor: "controller",
      phase: waitingPhase,
      payload: {},
    });
    const waiting = foldRunStatus({ root, runId, now: Date.now() });
    assert.equal(waiting.phase, "awaiting_decision");
    assert.equal(waiting.currentStepId, "plan");

    telemetry.append({
      type: "phase_finished",
      actor: "controller",
      phase: waitingPhase,
      payload: { status: "completed" },
    });
    telemetry.append({
      type: "phase_started",
      actor: "worker",
      phase: { id: "implement:1", name: "implementing", stepId: "implement", attempt: 1 },
      payload: {},
    });
    const implementing = foldRunStatus({ root, runId, now: Date.now() });
    assert.equal(implementing.phase, "implementing");
    assert.equal(implementing.currentStepId, "implement");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status retains review through cleanup, publication, and completion", () => {
  const root = temporary();
  try {
    const telemetry = createTelemetryWriter(root, runId);
    telemetry.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    completeReview(telemetry);
    telemetry.append({
      type: "cleanup_updated",
      actor: "controller",
      payload: { cleanup: "complete" },
    });
    const publishingPhase = { id: "publishing:1", name: "publishing" as const, attempt: 1 };
    telemetry.append({
      type: "phase_started",
      actor: "controller",
      phase: publishingPhase,
      payload: {},
    });
    assert.equal(foldRunStatus({ root, runId, now: Date.now() }).currentStepId, "review");
    telemetry.append({
      type: "phase_finished",
      actor: "controller",
      phase: publishingPhase,
      payload: { status: "completed" },
    });
    telemetry.append({
      type: "publication_completed",
      actor: "controller",
      payload: {
        number: 42,
        url: "https://github.com/santychuy/bookbounce/pull/42",
        branch: "maquila/riff-40-aaaaaaaaaaaa",
        commitSha: "b".repeat(40),
      },
    });
    telemetry.append({
      type: "run_finished",
      actor: "controller",
      payload: { status: "completed", cleanup: "complete" },
    });
    const completed = foldRunStatus({ root, runId });
    assert.equal(completed.status, "completed");
    assert.equal(completed.phase, "publishing");
    assert.equal(completed.currentStepId, "review");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status exposes an awaiting Linear decision", () => {
  const root = temporary();
  try {
    const telemetry = createTelemetryWriter(root, runId);
    telemetry.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    telemetry.append({
      type: "decision_requested",
      actor: "controller",
      payload: {
        count: 1,
        commentId: "comment-1",
        commentUrl: "https://linear.app/example/comment-1",
        continuationRunId: "22222222-2222-4222-8222-222222222222",
      },
    });
    telemetry.append({
      type: "cleanup_updated",
      actor: "controller",
      payload: { cleanup: "complete" },
    });
    telemetry.append({
      type: "run_finished",
      actor: "controller",
      payload: { status: "awaiting_decision", cleanup: "complete" },
    });
    const status = foldRunStatus({ root, runId });
    assert.equal(status.status, "awaiting_decision");
    assert.equal(status.failure, null);
    assert.equal(status.decision?.commentId, "comment-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status drops a Linear decision after planning resumes", () => {
  const root = temporary();
  try {
    const telemetry = createTelemetryWriter(root, runId);
    telemetry.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    telemetry.append({
      type: "decision_requested",
      actor: "controller",
      payload: {
        count: 1,
        commentId: "comment-1",
        commentUrl: "https://linear.app/example/comment-1",
        continuationRunId: runId,
      },
    });
    telemetry.append({
      type: "phase_started",
      actor: "controller",
      phase: { id: "awaiting_decision:1", name: "awaiting_decision", attempt: 1 },
      payload: {},
    });
    assert.equal(foldRunStatus({ root, runId, now: Date.now() }).decision?.commentId, "comment-1");
    telemetry.append({
      type: "phase_finished",
      actor: "controller",
      phase: { id: "awaiting_decision:1", name: "awaiting_decision", attempt: 1 },
      payload: { status: "completed" },
    });
    telemetry.append({
      type: "phase_started",
      actor: "planner",
      phase: { id: "planning:2", name: "planning", attempt: 2 },
      payload: {},
    });
    const resumed = foldRunStatus({ root, runId, now: Date.now() });
    assert.equal(resumed.status, "running");
    assert.equal(resumed.phase, "planning");
    assert.equal(resumed.decision, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("open decision phase stays awaiting instead of becoming stale", () => {
  const root = temporary();
  try {
    const telemetry = createTelemetryWriter(root, runId);
    telemetry.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    telemetry.append({
      type: "phase_started",
      actor: "controller",
      phase: { id: "awaiting_decision:1", name: "awaiting_decision", attempt: 1 },
      payload: {},
    });
    const status = foldRunStatus({ root, runId, now: Date.now() + 60_000, staleAfterMs: 1 });
    assert.equal(status.status, "awaiting_decision");
    assert.equal(status.phase, "awaiting_decision");
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
