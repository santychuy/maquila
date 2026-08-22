import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadAgent } from "../agents/index.js";
import type { DocumenterEnvelope, PlannerEnvelope } from "../envelope.js";
import { runAgent, type AgentActivity, type AgentRunResult } from "../run-agent.js";
import { isRemoteToolName, type RemoteEventSink } from "../remote-protocol.js";
import type { RunArtifacts } from "../run-artifacts.js";
import { assertSafeRepoPath, changedPaths } from "../verify.js";
import { isDocumentationPath, resolveFeaturePr } from "./feature-pr.js";
import { resolve } from "node:path";

function pathState(repo: string, path: string): string {
  const target = resolve(repo, path);
  try {
    const stat = lstatSync(target);
    const content = stat.isSymbolicLink() ? readlinkSync(target) : readFileSync(target);
    return createHash("sha256").update(`${stat.mode}:${stat.size}:`).update(content).digest("hex");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return "missing";
    throw error;
  }
}

function nonDocumentationSnapshot(repo: string): Map<string, string> {
  return new Map(
    changedPaths(repo)
      .filter((path) => !isDocumentationPath(path))
      .map((path) => [path, pathState(repo, path)]),
  );
}

export function documentPaths(plan: PlannerEnvelope): string[] {
  return resolveFeaturePr(plan).documentPaths;
}

export function assertOwnedPaths(
  repo: string,
  allowed: string[],
  owner: "worker" | "documenter",
): void {
  const unexpected = changedPaths(repo).filter((path) => {
    if (owner === "documenter" && !isDocumentationPath(path)) return false;
    const owned = owner === "documenter" ? isDocumentationPath(path) : !isDocumentationPath(path);
    return !owned || !allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  });
  if (unexpected.length)
    throw new Error(`${owner} changed paths outside approved ownership: ${unexpected.join(", ")}`);
}

function activityEvent(activity: AgentActivity): Parameters<RemoteEventSink>[0] {
  if (activity.type === "tool_started") {
    if (!isRemoteToolName(activity.toolName))
      throw new Error("unsupported documenter tool activity");
    return {
      type: "tool_started",
      actor: "documenter",
      phase: "documenting",
      stepId: "document",
      sourceAt: activity.at,
      toolName: activity.toolName,
      toolCallId: activity.toolCallId,
    };
  }
  if (activity.type === "tool_finished") {
    if (!isRemoteToolName(activity.toolName))
      throw new Error("unsupported documenter tool activity");
    return {
      type: "tool_finished",
      actor: "documenter",
      phase: "documenting",
      stepId: "document",
      sourceAt: activity.at,
      toolName: activity.toolName,
      toolCallId: activity.toolCallId,
      isError: activity.isError,
    };
  }
  const { at, ...event } = activity;
  return {
    ...event,
    sourceAt: at,
    actor: "documenter",
    phase: "documenting",
    stepId: "document",
  };
}

export async function runDocumenter(options: {
  repo: string;
  issue: string;
  plan: PlannerEnvelope;
  timeoutSeconds: number;
  artifacts: RunArtifacts;
  baseSha?: string;
  run?: typeof runAgent;
  onEvent?: RemoteEventSink;
}): Promise<AgentRunResult> {
  const allowed = documentPaths(options.plan);
  const before = nonDocumentationSnapshot(options.repo);
  options.onEvent?.({
    type: "phase_started",
    actor: "documenter",
    phase: "documenting",
    stepId: "document",
    sourceAt: new Date().toISOString(),
  });
  let status: AgentRunResult["status"] = "failed";
  try {
    const result = await (options.run ?? runAgent)({
      agent: loadAgent("documenter"),
      cwd: options.repo,
      timeoutSeconds: options.timeoutSeconds,
      prompt: `Issue:\n${options.issue}\n\nAccepted plan:\n${JSON.stringify(options.plan, null, 2)}\n\nApproved documentation paths: ${JSON.stringify(allowed)}\nUpdate documentation only when needed. Submit documenter envelope.`,
      artifacts: options.artifacts,
      envelopeRole: "documenter",
      ...(options.baseSha ? { receiptContext: { baseSha: options.baseSha } } : {}),
      onActivity: options.onEvent
        ? (activity) => options.onEvent?.(activityEvent(activity))
        : undefined,
    });
    status = result.status;
    if (result.status !== "completed") return result;
    if (!result.envelope || !("outcome" in result.envelope))
      throw new Error("documenter completed without a valid documenter envelope");
    const envelope: DocumenterEnvelope = result.envelope;
    if (envelope.outcome === "blocked") throw new Error(`documenter blocked: ${envelope.detail}`);
    assertOwnedPaths(options.repo, allowed, "documenter");
    const after = nonDocumentationSnapshot(options.repo);
    if (JSON.stringify([...before]) !== JSON.stringify([...after]))
      throw new Error("documenter changed existing non-documentation content");
    const actual = changedPaths(options.repo).filter(isDocumentationPath).toSorted();
    const reported = envelope.changedFiles.map(assertSafeRepoPath).toSorted();
    if (JSON.stringify(actual) !== JSON.stringify(reported))
      throw new Error("documenter envelope changedFiles does not match documentation diff");
    status = "completed";
    return result;
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    options.onEvent?.({
      type: "phase_finished",
      actor: "documenter",
      phase: "documenting",
      stepId: "document",
      status,
      sourceAt: new Date().toISOString(),
    });
  }
}
