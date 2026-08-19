import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadAgent } from "./agents.js";
import { renderPlannerPlan } from "./envelope.js";
import { runAgent, type AgentActivity, type AgentRunStatus } from "./run-agent.js";
import { isRemoteToolName, type RemoteEventSink } from "./remote-protocol.js";
import { createRunArtifacts } from "./run-artifacts.js";

export const MAX_TIMEOUT_SECONDS = 1800;

export interface PlanOptions {
  repo: string;
  issue: string;
  model: string;
  timeoutSeconds: number;
  machine?: boolean;
  onEvent?: RemoteEventSink;
}

export type PlanStatus = AgentRunStatus;

export interface PlanResult {
  runDir: string;
  status: PlanStatus;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}

function validateFile(path: string): void {
  if (!statSync(path).isFile()) throw new Error(`Not a file: ${path}`);
}

function validateRepo(path: string): void {
  if (!statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`);
  git(path, "rev-parse", "--is-inside-work-tree");
}

function activityEvent(activity: AgentActivity): Parameters<RemoteEventSink>[0] {
  if (activity.type === "tool_started") {
    if (!isRemoteToolName(activity.toolName)) throw new Error("unsupported planner tool activity");
    return {
      type: "tool_started",
      actor: "planner",
      phase: "planning",
      sourceAt: activity.at,
      toolName: activity.toolName,
      toolCallId: activity.toolCallId,
    };
  }
  if (activity.type === "tool_finished") {
    if (!isRemoteToolName(activity.toolName)) throw new Error("unsupported planner tool activity");
    return {
      type: "tool_finished",
      actor: "planner",
      phase: "planning",
      sourceAt: activity.at,
      toolName: activity.toolName,
      toolCallId: activity.toolCallId,
      isError: activity.isError,
    };
  }
  const { at, ...event } = activity;
  return { ...event, sourceAt: at, actor: "planner", phase: "planning" };
}

export async function runPlan(options: PlanOptions): Promise<PlanResult> {
  if (
    !Number.isInteger(options.timeoutSeconds) ||
    options.timeoutSeconds < 1 ||
    options.timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    throw new Error(`timeoutSeconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`);
  }

  const repo = resolve(options.repo);
  const issuePath = resolve(options.issue);
  validateRepo(repo);
  validateFile(issuePath);

  const issue = readFileSync(issuePath, "utf8");
  const planner = loadAgent("planner");
  const artifacts = createRunArtifacts(issue);

  const phaseStartedAt = new Date().toISOString();
  options.onEvent?.({
    type: "phase_started",
    actor: "planner",
    phase: "planning",
    sourceAt: phaseStartedAt,
  });
  const result = await runAgent({
    agent: planner,
    cwd: repo,
    model: options.model,
    timeoutSeconds: options.timeoutSeconds,
    prompt: `Plan this issue. Do not modify the repository.\n\n${issue}`,
    artifacts,
    envelopeRole: "planner",
    receiptContext: {
      repo,
      baseSha: git(repo, "rev-parse", "HEAD"),
      repoWasDirty: git(repo, "status", "--porcelain").length > 0,
      issueSha256: createHash("sha256").update(issue).digest("hex"),
    },
    onTextDelta: options.machine ? undefined : (delta) => process.stdout.write(delta),
    onActivity: options.onEvent
      ? (activity) => options.onEvent?.(activityEvent(activity))
      : undefined,
    onCompleted: (_finalText, target, envelope) => {
      if (!envelope || !("changes" in envelope))
        throw new Error("Planner completed without a valid planner envelope");
      target.write("plan.md", `${renderPlannerPlan(envelope)}\n`);
      return ["plan.md"];
    },
  });

  options.onEvent?.({
    type: "phase_finished",
    actor: "planner",
    phase: "planning",
    status: result.status,
    sourceAt: new Date().toISOString(),
  });
  return { runDir: result.runDir, status: result.status };
}
