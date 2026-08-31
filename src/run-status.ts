import { existsSync } from "node:fs";
import { readTelemetry, telemetryPathInStateDirectory, type TelemetryActor } from "./telemetry.js";
import { stateDirectory } from "./state-directory.js";
import type { WorkflowStepId } from "./workflow-step.js";

export type RunStatusName =
  | "unknown"
  | "legacy"
  | "invalid"
  | "running"
  | "activity_unknown"
  | "awaiting_decision"
  | "ready_for_publication"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunStatusSummary {
  version: 1;
  runId: string;
  status: RunStatusName;
  phase: string | null;
  currentStepId: WorkflowStepId | null;
  actor: TelemetryActor | null;
  currentTool: string | null;
  cleanup: "pending" | "complete" | "not-needed" | "failed" | null;
  lastActivity: string | null;
  runtimeMilliseconds: number | null;
  phaseRuntimeMilliseconds: number | null;
  failure: { code: string; message: string } | null;
  decision: {
    count: number;
    commentId: string;
    commentUrl: string;
    continuationRunId: string;
  } | null;
  pullRequest: { number: number; url: string; branch: string; commitSha: string } | null;
  artifacts: Array<{ name: string; size: number; sha256?: string }>;
}

export interface FoldRunStatusOptions {
  root: string;
  runId: string;
  now?: number;
  staleAfterMs?: number;
  controllerExists?: (runId: string) => boolean;
}

function base(runId: string, status: RunStatusName): RunStatusSummary {
  return {
    version: 1,
    runId,
    status,
    phase: null,
    currentStepId: null,
    actor: null,
    currentTool: null,
    cleanup: null,
    lastActivity: null,
    runtimeMilliseconds: null,
    phaseRuntimeMilliseconds: null,
    failure: null,
    decision: null,
    pullRequest: null,
    artifacts: [],
  };
}

export interface FoldRunStatusInStateDirectoryOptions extends Omit<FoldRunStatusOptions, "root"> {
  stateDirectory: string;
}

export function foldRunStatusInStateDirectory(
  options: FoldRunStatusInStateDirectoryOptions,
): RunStatusSummary {
  let path: string;
  try {
    path = telemetryPathInStateDirectory(options.stateDirectory, options.runId);
  } catch {
    return {
      ...base(options.runId, "invalid"),
      failure: { code: "invalid_run_id", message: "invalid run ID" },
    };
  }
  if (!existsSync(path)) {
    const legacy = options.controllerExists?.(options.runId) ?? false;
    return base(options.runId, legacy ? "legacy" : "unknown");
  }
  let records;
  try {
    records = readTelemetry(path);
  } catch {
    return {
      ...base(options.runId, "invalid"),
      failure: { code: "telemetry_invalid", message: "run telemetry is invalid" },
    };
  }
  if (!records.length) return base(options.runId, "unknown");
  if (records.some((record) => record.runId !== options.runId)) {
    return {
      ...base(options.runId, "invalid"),
      failure: { code: "telemetry_invalid", message: "run telemetry is invalid" },
    };
  }
  const summary = base(options.runId, "running");
  const openTools = new Map<string, string>();
  let terminal = false;
  let runStartedAt: number | undefined;
  let phaseStartedAt: number | undefined;
  let endedAt: number | undefined;
  for (const record of records) {
    summary.lastActivity = record.recordedAt;
    const recordedAt = Date.parse(record.recordedAt);
    if (record.type === "run_created") runStartedAt ??= recordedAt;
    if (record.type === "run_started") runStartedAt = recordedAt;
    if (record.type === "phase_started" && record.phase) {
      summary.phase = record.phase.name;
      if (record.phase.stepId) summary.currentStepId = record.phase.stepId;
      phaseStartedAt = recordedAt;
      summary.actor = record.actor;
      if (record.phase.name !== "awaiting_decision") summary.decision = null;
    }
    switch (record.type) {
      case "agent_started":
        summary.actor = record.actor;
        break;
      case "agent_finished":
      case "phase_finished":
        if (record.type === "phase_finished") {
          phaseStartedAt = undefined;
          if (record.phase?.name === "awaiting_decision") summary.decision = null;
        }
        summary.actor = null;
        openTools.clear();
        summary.currentTool = null;
        break;
      case "tool_started":
        summary.actor = record.actor;
        openTools.set(record.payload.toolCallId, record.payload.toolName);
        summary.currentTool = record.payload.toolName;
        break;
      case "tool_finished":
        openTools.delete(record.payload.toolCallId);
        summary.currentTool = [...openTools.values()].at(-1) ?? null;
        break;
      case "failure":
        summary.failure ??= { code: record.payload.stage, message: record.payload.message };
        break;
      case "decision_requested":
        summary.decision = record.payload;
        break;
      case "artifact_available":
        if (summary.artifacts.length < 100) summary.artifacts.push(record.payload);
        break;
      case "publication_completed":
        summary.pullRequest = record.payload;
        break;
      case "cleanup_updated":
        summary.cleanup = record.payload.cleanup;
        break;
      case "run_finished":
        terminal = true;
        endedAt = recordedAt;
        summary.status = record.payload.status;
        summary.cleanup = record.payload.cleanup;
        summary.currentTool = null;
        summary.actor = null;
        if (record.payload.status !== "awaiting_decision") summary.decision = null;
        break;
    }
  }
  const now = options.now ?? Date.now();
  const durationEnd = endedAt ?? now;
  if (runStartedAt !== undefined)
    summary.runtimeMilliseconds = Math.max(0, durationEnd - runStartedAt);
  if (phaseStartedAt !== undefined && !terminal)
    summary.phaseRuntimeMilliseconds = Math.max(0, now - phaseStartedAt);
  if (!terminal) {
    if (summary.phase === "awaiting_decision") summary.status = "awaiting_decision";
    else {
      const freshness = Date.parse(summary.lastActivity ?? "");
      if (!Number.isFinite(freshness) || now - freshness > (options.staleAfterMs ?? 30_000))
        summary.status = "activity_unknown";
    }
  }
  return summary;
}

/** Compatibility wrapper for project-root callers. */
export function foldRunStatus(options: FoldRunStatusOptions): RunStatusSummary {
  const { root, ...rest } = options;
  return foldRunStatusInStateDirectory({ ...rest, stateDirectory: stateDirectory(root) });
}
