import { existsSync } from "node:fs";
import { readTelemetry, telemetryPath, type TelemetryActor } from "./telemetry.js";

export type RunStatusName =
  | "unknown"
  | "legacy"
  | "invalid"
  | "running"
  | "activity_unknown"
  | "ready_for_publication"
  | "completed"
  | "failed";

export interface RunStatusSummary {
  version: 1;
  runId: string;
  status: RunStatusName;
  phase: string | null;
  actor: TelemetryActor | null;
  currentTool: string | null;
  cleanup: "pending" | "complete" | "not-needed" | "failed" | null;
  lastActivity: string | null;
  runtimeMilliseconds: number | null;
  phaseRuntimeMilliseconds: number | null;
  failure: { code: string; message: string } | null;
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
    actor: null,
    currentTool: null,
    cleanup: null,
    lastActivity: null,
    runtimeMilliseconds: null,
    phaseRuntimeMilliseconds: null,
    failure: null,
    pullRequest: null,
    artifacts: [],
  };
}

export function foldRunStatus(options: FoldRunStatusOptions): RunStatusSummary {
  let path: string;
  try {
    path = telemetryPath(options.root, options.runId);
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
      phaseStartedAt = recordedAt;
      summary.actor = record.actor;
    }
    switch (record.type) {
      case "agent_started":
        summary.actor = record.actor;
        break;
      case "agent_finished":
      case "phase_finished":
        if (record.type === "phase_finished") phaseStartedAt = undefined;
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
    const freshness = Date.parse(summary.lastActivity ?? "");
    if (!Number.isFinite(freshness) || now - freshness > (options.staleAfterMs ?? 30_000))
      summary.status = "activity_unknown";
  }
  return summary;
}
