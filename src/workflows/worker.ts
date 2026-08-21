import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadAgent } from "../agents/index.js";
import { parseEnvelope, type PlannerEnvelope, type ReviewerEnvelope } from "../envelope.js";
import { assertOwnedPaths, runDocumenter } from "./document.js";
import {
  agentFailureCode,
  runAgent,
  type AgentActivity,
  type AgentRunResult,
} from "../run-agent.js";
import { isRemoteToolName, type RemoteEventSink, type RemoteFailure } from "../remote-protocol.js";
import { createRunArtifacts, type RunArtifacts } from "../run-artifacts.js";
import {
  assertCleanBaseline,
  assertSafeRepoPath,
  verifyRepository,
  type VerificationResult,
} from "../verify.js";

const MAX_REVIEW_DIFF_BYTES = 1_000_000;

type LifecycleStatus = "completed" | "failed" | "timed_out";

export interface WorkerLifecycleOptions {
  repo: string;
  issue: string;
  plannerEnvelope: string;
  baseSha: string;
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
  failure?: RemoteFailure;
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
  actor: "worker" | "documenter" | "reviewer",
  phase: "implementing" | "documenting" | "reviewing",
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
  actor: "worker" | "documenter" | "verifier" | "reviewer",
  phase: "implementing" | "documenting" | "verifying" | "reviewing",
  status?: LifecycleStatus,
): void {
  const sourceAt = new Date().toISOString();
  if (type === "phase_started") sink?.({ type, actor, phase, sourceAt });
  else sink?.({ type, actor, phase, status: status!, sourceAt });
}

function promptIssue(issue: string, plan: PlannerEnvelope): string {
  const changes = plan.changes.filter(
    (change) => !(change.path === "docs" || change.path.startsWith("docs/")),
  );
  return `Issue:\n${issue}\n\nAccepted non-documentation plan:\n${JSON.stringify({ ...plan, changes }, null, 2)}\nImplement plan. Do not modify docs/. Submit worker envelope.`;
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
  const workerPaths = paths.filter((path) => !(path === "docs" || path.startsWith("docs/")));
  let worker: AgentRunResult | undefined;
  if (workerPaths.length) {
    phaseEvent(options.onEvent, "phase_started", "worker", "implementing");
    try {
      worker = await run({
        agent: loadAgent("worker"),
        cwd: options.repo,
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
      return {
        status: "failed",
        runDir: workerArtifacts.runDir,
        failure: { phase: "implementing", code: "agent_failed" },
      };
    }

    if (worker.status !== "completed" || !worker.envelope) {
      phaseEvent(options.onEvent, "phase_finished", "worker", "implementing", worker.status);
      writeLifecycle(workerArtifacts, {
        status: worker.status,
        stage: "worker",
        ...(worker.receipt.error ? { error: worker.receipt.error } : {}),
        workerRunDir: worker.runDir,
      });
      return {
        status: worker.status,
        runDir: worker.runDir,
        failure: { phase: "implementing", code: agentFailureCode(worker) },
      };
    }
    try {
      assertOwnedPaths(options.repo, workerPaths, "worker");
    } catch (error) {
      phaseEvent(options.onEvent, "phase_finished", "worker", "implementing", "failed");
      writeLifecycle(workerArtifacts, {
        status: "failed",
        stage: "worker",
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: "failed",
        runDir: worker.runDir,
        failure: { phase: "implementing", code: "ownership_failed" },
      };
    }
    phaseEvent(options.onEvent, "phase_finished", "worker", "implementing", "completed");
  }

  const documenterArtifacts = worker ? createRunArtifacts(issue, options.root) : workerArtifacts;
  let documenter: AgentRunResult;
  try {
    documenter = await runDocumenter({
      repo: options.repo,
      issue,
      plan,
      timeoutSeconds: options.timeoutSeconds,
      artifacts: documenterArtifacts,
      baseSha: options.baseSha,
      run,
      onEvent: options.onEvent,
    });
  } catch (error) {
    writeLifecycle(workerArtifacts, {
      status: "failed",
      stage: "documenter",
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "failed",
      runDir: worker?.runDir ?? documenterArtifacts.runDir,
      failure: { phase: "documenting", code: "agent_failed" },
    };
  }
  if (documenter.status !== "completed" || !documenter.envelope) {
    writeLifecycle(workerArtifacts, {
      status: documenter.status,
      stage: "documenter",
      ...(documenter.receipt.error ? { error: documenter.receipt.error } : {}),
      documenterRunDir: documenter.runDir,
    });
    return {
      status: documenter.status,
      runDir: worker?.runDir ?? documenter.runDir,
      failure: { phase: "documenting", code: agentFailureCode(documenter) },
    };
  }

  const primaryRun = worker ?? documenter;
  const primaryArtifacts = worker ? workerArtifacts : documenterArtifacts;
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
    primaryArtifacts.writeJson("verification.json", {
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    });
    addArtifact(primaryArtifacts, "verification.json");
    writeLifecycle(primaryArtifacts, {
      status: "failed",
      stage: "verification",
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "failed",
      runDir: worker?.runDir ?? documenter.runDir,
      failure: { phase: "verifying", code: "verification_failed" },
    };
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
  primaryArtifacts.writeJson("verification.json", verification);
  addArtifact(primaryArtifacts, "verification.json");
  if (!verification.passed) {
    const status = verification.commands.some((command) => command.timedOut)
      ? "timed_out"
      : "failed";
    writeLifecycle(primaryArtifacts, {
      status,
      stage: "verification",
      verification,
    });
    return {
      status,
      runDir: worker?.runDir ?? documenter.runDir,
      verification,
      failure: {
        phase: "verifying",
        code: status === "timed_out" ? "timed_out" : "verification_failed",
      },
    };
  }

  let patch: string;
  try {
    patch = reviewDiff(options.repo);
    primaryArtifacts.write(
      "review-diff.sha256",
      `${createHash("sha256").update(patch).digest("hex")}\n`,
    );
    addArtifact(primaryArtifacts, "review-diff.sha256");
  } catch (error) {
    writeLifecycle(primaryArtifacts, {
      status: "failed",
      stage: "review_snapshot",
      error: error instanceof Error ? error.message : String(error),
      verification,
    });
    return {
      status: "failed",
      runDir: primaryRun.runDir,
      verification,
      failure: { phase: "reviewing", code: "agent_failed" },
    };
  }

  const reviewerArtifacts = createRunArtifacts(issue, options.root);
  phaseEvent(options.onEvent, "phase_started", "reviewer", "reviewing");
  const reviewPrompt = `Issue:\n${issue}\n\nAccepted plan:\n${JSON.stringify(plan, null, 2)}\n\nGit diff:\n${patch}\n\nDeterministic verification:\n${JSON.stringify(verification, null, 2)}\nReview implementation. Submit reviewer envelope.`;
  let reviewer: AgentRunResult;
  try {
    reviewer = await run({
      agent: loadAgent("reviewer"),
      cwd: options.repo,
      timeoutSeconds: options.timeoutSeconds,
      prompt: reviewPrompt,
      artifacts: reviewerArtifacts,
      envelopeRole: "reviewer",
      receiptContext: {
        baseSha: options.baseSha,
        ...(worker ? { workerRunId: worker.receipt.runId } : {}),
        documenterRunId: documenter.receipt.runId,
      },
      onActivity: options.onEvent
        ? (activity) => options.onEvent?.(activityEvent(activity, "reviewer", "reviewing"))
        : undefined,
    });
  } catch (error) {
    phaseEvent(options.onEvent, "phase_finished", "reviewer", "reviewing", "failed");
    writeLifecycle(primaryArtifacts, {
      status: "failed",
      stage: "reviewer",
      error: error instanceof Error ? error.message : String(error),
      ...(worker ? { workerRunDir: worker.runDir } : {}),
      documenterRunDir: documenter.runDir,
      reviewerRunDir: reviewerArtifacts.runDir,
      verification,
    });
    return {
      status: "failed",
      runDir: primaryRun.runDir,
      reviewerRunDir: reviewerArtifacts.runDir,
      verification,
      failure: { phase: "reviewing", code: "agent_failed" },
    };
  }

  if (reviewer.status !== "completed" || !reviewer.envelope) {
    phaseEvent(options.onEvent, "phase_finished", "reviewer", "reviewing", reviewer.status);
    const lifecycle = {
      status: reviewer.status,
      stage: "reviewer",
      ...(reviewer.receipt.error ? { error: reviewer.receipt.error } : {}),
      ...(worker ? { workerRunDir: worker.runDir } : {}),
      documenterRunDir: documenter.runDir,
      reviewerRunDir: reviewer.runDir,
      verification,
    };
    writeLifecycle(primaryArtifacts, lifecycle);
    writeLifecycle(reviewerArtifacts, lifecycle);
    return {
      status: reviewer.status,
      runDir: primaryRun.runDir,
      reviewerRunDir: reviewer.runDir,
      verification,
      failure: { phase: "reviewing", code: agentFailureCode(reviewer) },
    };
  }

  if (!("verdict" in reviewer.envelope)) {
    phaseEvent(options.onEvent, "phase_finished", "reviewer", "reviewing", "failed");
    const lifecycle = {
      status: "failed" as const,
      stage: "reviewer",
      error: "reviewer completed without reviewer envelope",
      ...(worker ? { workerRunDir: worker.runDir } : {}),
      documenterRunDir: documenter.runDir,
      reviewerRunDir: reviewer.runDir,
      verification,
    };
    writeLifecycle(primaryArtifacts, lifecycle);
    writeLifecycle(reviewerArtifacts, lifecycle);
    return {
      status: "failed",
      runDir: primaryRun.runDir,
      reviewerRunDir: reviewer.runDir,
      verification,
      failure: { phase: "reviewing", code: "envelope_invalid" },
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
    ...(worker ? { workerRunId: worker.receipt.runId, workerRunDir: worker.runDir } : {}),
    documenterRunId: documenter.receipt.runId,
    documenterRunDir: documenter.runDir,
    reviewerRunId: reviewer.receipt.runId,
    reviewerRunDir: reviewer.runDir,
    reviewPatchSha256: createHash("sha256").update(patch).digest("hex"),
    verification,
  };
  writeLifecycle(primaryArtifacts, lifecycle);
  writeLifecycle(reviewerArtifacts, lifecycle);
  return {
    status,
    runDir: primaryRun.runDir,
    reviewerRunDir: reviewer.runDir,
    verification,
    reviewer: envelope,
    ...(status === "failed"
      ? { failure: { phase: "reviewing" as const, code: "review_failed" as const } }
      : {}),
  };
}
