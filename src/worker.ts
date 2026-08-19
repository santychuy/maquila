import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadAgent } from "./agents/index.js";
import { parseEnvelope, type PlannerEnvelope, type ReviewerEnvelope } from "./envelope.js";
import { runAgent, type AgentActivity, type AgentRunResult } from "./run-agent.js";
import { isRemoteToolName, type RemoteEventSink } from "./remote-protocol.js";
import { createRunArtifacts, type RunArtifacts } from "./run-artifacts.js";
import {
  assertCleanBaseline,
  assertSafeRepoPath,
  verifyRepository,
  type VerificationResult,
} from "./verify.js";

const MAX_REVIEW_DIFF_BYTES = 1_000_000;

type LifecycleStatus = "completed" | "failed" | "timed_out";

export interface WorkerLifecycleOptions {
  repo: string;
  issue: string;
  plannerEnvelope: string;
  baseSha: string;
  model: string;
  timeoutSeconds: number;
  root?: string;
  runAgent?: typeof runAgent;
  verifyRepository?: typeof verifyRepository;
  onEvent?: RemoteEventSink;
}

export interface WorkerLifecycleResult {
  status: LifecycleStatus;
  runDir: string;
  reviewerRunDir?: string;
  verification?: VerificationResult;
  reviewer?: ReviewerEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPlanner(path: string): PlannerEnvelope {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const result = parseEnvelope("planner", parsed);
  if (!result.ok) throw new Error(`planner envelope rejected: ${result.errors.join("; ")}`);
  if (result.envelope.decisionsNeeded.length) throw new Error("planner has unresolved decisions");
  return result.envelope;
}

function approvedPaths(plan: PlannerEnvelope): string[] {
  const paths = plan.changes.map((change) => assertSafeRepoPath(change.path));
  if (new Set(paths).size !== paths.length) throw new Error("planner contains duplicate paths");
  if (paths.includes("factory.verify.json")) {
    throw new Error("planner cannot approve factory.verify.json");
  }
  return paths;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout: 10_000 });
}

function reviewDiff(repo: string): string {
  git(repo, ["add", "-A"]);
  const patch = git(repo, ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD"]);
  if (Buffer.byteLength(patch) > MAX_REVIEW_DIFF_BYTES) {
    throw new Error(`review diff exceeds ${MAX_REVIEW_DIFF_BYTES} bytes`);
  }
  return patch;
}

function addArtifact(artifacts: RunArtifacts, name: string): void {
  const path = resolve(artifacts.runDir, "receipt.json");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.artifacts)) {
    throw new Error(`receipt missing artifacts: ${artifacts.runDir}`);
  }
  if (!parsed.artifacts.includes(name)) parsed.artifacts.push(name);
  artifacts.writeJson("receipt.json", parsed);
}

function writeLifecycle(
  artifacts: RunArtifacts,
  value: Record<string, unknown> & { status: LifecycleStatus; stage: string },
): void {
  artifacts.writeJson("lifecycle.json", value);
  const receiptPath = resolve(artifacts.runDir, "receipt.json");
  if (existsSync(receiptPath)) {
    addArtifact(artifacts, "lifecycle.json");
    return;
  }
  artifacts.writeJson("receipt.json", {
    kind: "lifecycle",
    runId: artifacts.runId,
    status: value.status,
    stage: value.stage,
    artifacts: ["issue.md", "events.jsonl", "receipt.json", "lifecycle.json"],
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  });
}

function activityEvent(
  activity: AgentActivity,
  actor: "worker" | "reviewer",
  phase: "implementing" | "reviewing",
): Parameters<RemoteEventSink>[0] {
  if (activity.type === "tool_started") {
    if (!isRemoteToolName(activity.toolName)) throw new Error(`unsupported ${actor} tool activity`);
    return {
      type: "tool_started",
      actor,
      phase,
      sourceAt: activity.at,
      toolName: activity.toolName,
      toolCallId: activity.toolCallId,
    };
  }
  if (activity.type === "tool_finished") {
    if (!isRemoteToolName(activity.toolName)) throw new Error(`unsupported ${actor} tool activity`);
    return {
      type: "tool_finished",
      actor,
      phase,
      sourceAt: activity.at,
      toolName: activity.toolName,
      toolCallId: activity.toolCallId,
      isError: activity.isError,
    };
  }
  const { at, ...event } = activity;
  return { ...event, sourceAt: at, actor, phase };
}

function phaseEvent(
  sink: RemoteEventSink | undefined,
  type: "phase_started" | "phase_finished",
  actor: "worker" | "verifier" | "reviewer",
  phase: "implementing" | "verifying" | "reviewing",
  status?: LifecycleStatus,
): void {
  const sourceAt = new Date().toISOString();
  if (type === "phase_started") sink?.({ type, actor, phase, sourceAt });
  else sink?.({ type, actor, phase, status: status!, sourceAt });
}

function promptIssue(issue: string, plan: PlannerEnvelope): string {
  return `Issue:\n${issue}\n\nAccepted plan:\n${JSON.stringify(plan, null, 2)}\nImplement plan. Submit worker envelope.`;
}

export async function runWorkerLifecycle(
  options: WorkerLifecycleOptions,
): Promise<WorkerLifecycleResult> {
  if (
    !Number.isInteger(options.timeoutSeconds) ||
    options.timeoutSeconds < 1 ||
    options.timeoutSeconds > 1800
  ) {
    throw new Error("timeoutSeconds must be an integer from 1 to 1800");
  }

  const issue = readFileSync(resolve(options.issue), "utf8");
  const workerArtifacts = createRunArtifacts(issue, options.root);
  let plan: PlannerEnvelope;
  let paths: string[];
  try {
    plan = readPlanner(options.plannerEnvelope);
    paths = approvedPaths(plan);
  } catch (error) {
    writeLifecycle(workerArtifacts, {
      status: "failed",
      stage: "planner",
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "failed", runDir: workerArtifacts.runDir };
  }

  try {
    assertCleanBaseline(options.repo, options.baseSha);
  } catch (error) {
    writeLifecycle(workerArtifacts, {
      status: "failed",
      stage: "baseline",
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "failed", runDir: workerArtifacts.runDir };
  }

  const run = options.runAgent ?? runAgent;
  const verify = options.verifyRepository ?? verifyRepository;
  let worker: AgentRunResult;
  phaseEvent(options.onEvent, "phase_started", "worker", "implementing");
  try {
    worker = await run({
      agent: loadAgent("worker"),
      cwd: options.repo,
      model: options.model,
      timeoutSeconds: options.timeoutSeconds,
      prompt: promptIssue(issue, plan),
      artifacts: workerArtifacts,
      envelopeRole: "worker",
      receiptContext: { baseSha: options.baseSha },
      onActivity: options.onEvent
        ? (activity) => options.onEvent?.(activityEvent(activity, "worker", "implementing"))
        : undefined,
    });
  } catch (error) {
    phaseEvent(options.onEvent, "phase_finished", "worker", "implementing", "failed");
    writeLifecycle(workerArtifacts, {
      status: "failed",
      stage: "worker",
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "failed", runDir: workerArtifacts.runDir };
  }

  phaseEvent(options.onEvent, "phase_finished", "worker", "implementing", worker.status);
  if (worker.status !== "completed" || !worker.envelope) {
    writeLifecycle(workerArtifacts, {
      status: worker.status,
      stage: "worker",
      workerRunDir: worker.runDir,
    });
    return { status: worker.status, runDir: worker.runDir };
  }

  let verification: VerificationResult;
  phaseEvent(options.onEvent, "phase_started", "verifier", "verifying");
  try {
    verification = await verify({
      repo: options.repo,
      baseSha: options.baseSha,
      allowedPaths: paths,
      commandTimeoutMs: options.timeoutSeconds * 1000,
    });
  } catch (error) {
    phaseEvent(options.onEvent, "phase_finished", "verifier", "verifying", "failed");
    workerArtifacts.writeJson("verification.json", {
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    });
    addArtifact(workerArtifacts, "verification.json");
    writeLifecycle(workerArtifacts, {
      status: "failed",
      stage: "verification",
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "failed", runDir: worker.runDir };
  }

  options.onEvent?.({
    type: "gate_finished",
    actor: "verifier",
    phase: "verifying",
    passed: verification.passed,
    commandCount: verification.commands.length,
    changedPathCount: verification.git.changedPaths.length,
    timedOut: verification.commands.some((command) => command.timedOut),
    sourceAt: new Date().toISOString(),
  });
  phaseEvent(
    options.onEvent,
    "phase_finished",
    "verifier",
    "verifying",
    verification.passed
      ? "completed"
      : verification.commands.some((command) => command.timedOut)
        ? "timed_out"
        : "failed",
  );
  workerArtifacts.writeJson("verification.json", verification);
  addArtifact(workerArtifacts, "verification.json");
  if (!verification.passed) {
    const status = verification.commands.some((command) => command.timedOut)
      ? "timed_out"
      : "failed";
    writeLifecycle(workerArtifacts, {
      status,
      stage: "verification",
      verification,
    });
    return { status, runDir: worker.runDir, verification };
  }

  let patch: string;
  try {
    patch = reviewDiff(options.repo);
    workerArtifacts.write(
      "review-diff.sha256",
      `${createHash("sha256").update(patch).digest("hex")}\n`,
    );
    addArtifact(workerArtifacts, "review-diff.sha256");
  } catch (error) {
    writeLifecycle(workerArtifacts, {
      status: "failed",
      stage: "review_snapshot",
      error: error instanceof Error ? error.message : String(error),
      verification,
    });
    return { status: "failed", runDir: worker.runDir, verification };
  }

  const reviewerArtifacts = createRunArtifacts(issue, options.root);
  phaseEvent(options.onEvent, "phase_started", "reviewer", "reviewing");
  const reviewPrompt = `Issue:\n${issue}\n\nAccepted plan:\n${JSON.stringify(plan, null, 2)}\n\nGit diff:\n${patch}\n\nDeterministic verification:\n${JSON.stringify(verification, null, 2)}\nReview implementation. Submit reviewer envelope.`;
  let reviewer: AgentRunResult;
  try {
    reviewer = await run({
      agent: loadAgent("reviewer"),
      cwd: options.repo,
      model: options.model,
      timeoutSeconds: options.timeoutSeconds,
      prompt: reviewPrompt,
      artifacts: reviewerArtifacts,
      envelopeRole: "reviewer",
      receiptContext: { baseSha: options.baseSha, workerRunId: worker.receipt.runId },
      onActivity: options.onEvent
        ? (activity) => options.onEvent?.(activityEvent(activity, "reviewer", "reviewing"))
        : undefined,
    });
  } catch (error) {
    phaseEvent(options.onEvent, "phase_finished", "reviewer", "reviewing", "failed");
    writeLifecycle(workerArtifacts, {
      status: "failed",
      stage: "reviewer",
      error: error instanceof Error ? error.message : String(error),
      reviewerRunDir: reviewerArtifacts.runDir,
      verification,
    });
    return {
      status: "failed",
      runDir: worker.runDir,
      reviewerRunDir: reviewerArtifacts.runDir,
      verification,
    };
  }

  if (reviewer.status !== "completed" || !reviewer.envelope) {
    phaseEvent(options.onEvent, "phase_finished", "reviewer", "reviewing", reviewer.status);
    const lifecycle = {
      status: reviewer.status,
      stage: "reviewer",
      workerRunDir: worker.runDir,
      reviewerRunDir: reviewer.runDir,
      verification,
    };
    writeLifecycle(workerArtifacts, lifecycle);
    writeLifecycle(reviewerArtifacts, lifecycle);
    return {
      status: reviewer.status,
      runDir: worker.runDir,
      reviewerRunDir: reviewer.runDir,
      verification,
    };
  }

  if (!("verdict" in reviewer.envelope)) {
    phaseEvent(options.onEvent, "phase_finished", "reviewer", "reviewing", "failed");
    const lifecycle = {
      status: "failed" as const,
      stage: "reviewer",
      error: "reviewer completed without reviewer envelope",
      workerRunDir: worker.runDir,
      reviewerRunDir: reviewer.runDir,
      verification,
    };
    writeLifecycle(workerArtifacts, lifecycle);
    writeLifecycle(reviewerArtifacts, lifecycle);
    return {
      status: "failed",
      runDir: worker.runDir,
      reviewerRunDir: reviewer.runDir,
      verification,
    };
  }

  const envelope: ReviewerEnvelope = reviewer.envelope;
  const status: LifecycleStatus = envelope.verdict === "PASS" ? "completed" : "failed";
  options.onEvent?.({
    type: "review_finished",
    actor: "reviewer",
    phase: "reviewing",
    verdict: envelope.verdict,
    blockerCount: envelope.blockingFindings.length,
    sourceAt: new Date().toISOString(),
  });
  phaseEvent(options.onEvent, "phase_finished", "reviewer", "reviewing", status);
  const lifecycle = {
    status,
    stage: "reviewer",
    baseSha: options.baseSha,
    allowedPaths: paths,
    workerRunId: worker.receipt.runId,
    workerRunDir: worker.runDir,
    reviewerRunId: reviewer.receipt.runId,
    reviewerRunDir: reviewer.runDir,
    reviewPatchSha256: createHash("sha256").update(patch).digest("hex"),
    verification,
  };
  writeLifecycle(workerArtifacts, lifecycle);
  writeLifecycle(reviewerArtifacts, lifecycle);
  return {
    status,
    runDir: worker.runDir,
    reviewerRunDir: reviewer.runDir,
    verification,
    reviewer: envelope,
  };
}
