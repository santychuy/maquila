import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadAgent } from "../agents/index.js";
import { parseEnvelope, type PlannerEnvelope, type ReviewerEnvelope } from "../envelope.js";
import { assertOwnedPaths, runDocumenter } from "./document.js";
import { isDocumentationPath } from "./feature-pr.js";
import { createFeaturePrExecution } from "./execution.js";
import {
  assertFeaturePrManifest,
  createFeaturePrManifest,
  plannerRunIdFromEnvelopePath,
  readWorkflowManifest,
  type WorkflowManifest,
} from "./manifest.js";
import {
  agentFailureCode,
  runAgent,
  type AgentActivity,
  type AgentRunResult,
} from "../run-agent.js";
import { isRemoteToolName, type RemoteEventSink, type RemoteFailure } from "../remote-protocol.js";
import { createRunArtifacts, type RunArtifacts } from "../run-artifacts.js";
import { assertCleanBaseline, verifyRepository, type VerificationResult } from "../verify.js";
import { workflowStep, type WorkflowStepId } from "../workflow-step.js";

const MAX_REVIEW_DIFF_BYTES = 1_000_000;

type LifecycleStatus = "completed" | "failed" | "timed_out";

export interface WorkerLifecycleOptions {
  repo: string;
  issue: string;
  plannerEnvelope: string;
  baseSha: string;
  timeoutSeconds: number;
  workflowManifest?: string;
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

interface BlockContext {
  repo: string;
  issue: string;
  plan: PlannerEnvelope;
  baseSha: string;
  timeoutSeconds: number;
  root?: string;
  onEvent?: RemoteEventSink;
  run: typeof runAgent;
  verify: typeof verifyRepository;
  allowedPaths: string[];
  implementPaths: string[];
  workerArtifacts: RunArtifacts;
  manifest: WorkflowManifest;
}

interface BlockState {
  worker?: AgentRunResult;
  documenter?: AgentRunResult;
  verification?: VerificationResult;
}

type BlockOutcome =
  | { status: "continue"; state: BlockState }
  | { status: "stop"; result: WorkerLifecycleResult };

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
  stepId: "implement" | "review",
): Parameters<RemoteEventSink>[0] {
  const { actor, phase } = workflowStep(stepId);
  if (activity.type === "tool_started") {
    if (!isRemoteToolName(activity.toolName)) throw new Error(`unsupported ${actor} tool activity`);
    return {
      type: "tool_started",
      actor,
      phase,
      stepId,
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
      stepId,
      sourceAt: activity.at,
      toolName: activity.toolName,
      toolCallId: activity.toolCallId,
      isError: activity.isError,
    };
  }
  const { at, ...event } = activity;
  return { ...event, sourceAt: at, actor, phase, stepId };
}

function phaseEvent(
  sink: RemoteEventSink | undefined,
  type: "phase_started",
  stepId: Exclude<WorkflowStepId, "plan" | "document">,
): void;
function phaseEvent(
  sink: RemoteEventSink | undefined,
  type: "phase_finished",
  stepId: Exclude<WorkflowStepId, "plan" | "document">,
  status: LifecycleStatus,
): void;
function phaseEvent(
  sink: RemoteEventSink | undefined,
  type: "phase_started" | "phase_finished",
  stepId: Exclude<WorkflowStepId, "plan" | "document">,
  status?: LifecycleStatus,
): void {
  const sourceAt = new Date().toISOString();
  const { actor, phase } = workflowStep(stepId);
  if (type === "phase_started") sink?.({ type, actor, phase, stepId, sourceAt });
  else sink?.({ type, actor, phase, stepId, status: status!, sourceAt });
}

function promptIssue(issue: string, plan: PlannerEnvelope): string {
  const changes = plan.changes.filter((change) => !isDocumentationPath(change.path));
  return `Issue:\n${issue}\n\nAccepted non-documentation plan:\n${JSON.stringify({ ...plan, changes }, null, 2)}\nImplement plan. Do not modify docs/. Submit worker envelope.`;
}

async function runImplementBlock(context: BlockContext, state: BlockState): Promise<BlockOutcome> {
  phaseEvent(context.onEvent, "phase_started", "implement");
  let worker: AgentRunResult;
  try {
    worker = await context.run({
      agent: loadAgent("worker"),
      cwd: context.repo,
      timeoutSeconds: context.timeoutSeconds,
      prompt: promptIssue(context.issue, context.plan),
      artifacts: context.workerArtifacts,
      envelopeRole: "worker",
      receiptContext: { baseSha: context.baseSha },
      onActivity: context.onEvent
        ? (activity) => context.onEvent?.(activityEvent(activity, "implement"))
        : undefined,
    });
  } catch (error) {
    phaseEvent(context.onEvent, "phase_finished", "implement", "failed");
    writeLifecycle(context.workerArtifacts, {
      status: "failed",
      stage: "worker",
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "stop",
      result: {
        status: "failed",
        runDir: context.workerArtifacts.runDir,
        failure: { phase: "implementing", code: "agent_failed" },
      },
    };
  }

  if (worker.status !== "completed" || !worker.envelope) {
    phaseEvent(context.onEvent, "phase_finished", "implement", worker.status);
    writeLifecycle(context.workerArtifacts, {
      status: worker.status,
      stage: "worker",
      ...(worker.receipt.error ? { error: worker.receipt.error } : {}),
      workerRunDir: worker.runDir,
    });
    return {
      status: "stop",
      result: {
        status: worker.status,
        runDir: worker.runDir,
        failure: { phase: "implementing", code: agentFailureCode(worker) },
      },
    };
  }
  try {
    assertOwnedPaths(context.repo, context.implementPaths, "worker");
  } catch (error) {
    phaseEvent(context.onEvent, "phase_finished", "implement", "failed");
    writeLifecycle(context.workerArtifacts, {
      status: "failed",
      stage: "worker",
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "stop",
      result: {
        status: "failed",
        runDir: worker.runDir,
        failure: { phase: "implementing", code: "ownership_failed" },
      },
    };
  }
  phaseEvent(context.onEvent, "phase_finished", "implement", "completed");
  return { status: "continue", state: { ...state, worker } };
}

async function runDocumentBlock(context: BlockContext, state: BlockState): Promise<BlockOutcome> {
  const documenterArtifacts = state.worker
    ? createRunArtifacts(context.issue, context.root)
    : context.workerArtifacts;
  let documenter: AgentRunResult;
  try {
    documenter = await runDocumenter({
      repo: context.repo,
      issue: context.issue,
      plan: context.plan,
      timeoutSeconds: context.timeoutSeconds,
      artifacts: documenterArtifacts,
      baseSha: context.baseSha,
      run: context.run,
      onEvent: context.onEvent,
    });
  } catch (error) {
    writeLifecycle(context.workerArtifacts, {
      status: "failed",
      stage: "documenter",
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "stop",
      result: {
        status: "failed",
        runDir: state.worker?.runDir ?? documenterArtifacts.runDir,
        failure: { phase: "documenting", code: "agent_failed" },
      },
    };
  }
  if (documenter.status !== "completed" || !documenter.envelope) {
    writeLifecycle(context.workerArtifacts, {
      status: documenter.status,
      stage: "documenter",
      ...(documenter.receipt.error ? { error: documenter.receipt.error } : {}),
      documenterRunDir: documenter.runDir,
    });
    return {
      status: "stop",
      result: {
        status: documenter.status,
        runDir: state.worker?.runDir ?? documenter.runDir,
        failure: { phase: "documenting", code: agentFailureCode(documenter) },
      },
    };
  }
  return { status: "continue", state: { ...state, documenter } };
}

async function runVerifyBlock(context: BlockContext, state: BlockState): Promise<BlockOutcome> {
  const worker = state.worker;
  const documenter = state.documenter;
  if (!documenter) throw new Error("documenter result is missing");
  const primaryArtifacts = context.workerArtifacts;
  let verification: VerificationResult;
  phaseEvent(context.onEvent, "phase_started", "verify");
  try {
    verification = await context.verify({
      repo: context.repo,
      baseSha: context.baseSha,
      allowedPaths: context.allowedPaths,
      commandTimeoutMs: context.timeoutSeconds * 1000,
    });
  } catch (error) {
    phaseEvent(context.onEvent, "phase_finished", "verify", "failed");
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
      status: "stop",
      result: {
        status: "failed",
        runDir: worker?.runDir ?? documenter.runDir,
        failure: { phase: "verifying", code: "verification_failed" },
      },
    };
  }

  context.onEvent?.({
    type: "gate_finished",
    actor: "verifier",
    phase: "verifying",
    stepId: "verify",
    passed: verification.passed,
    commandCount: verification.commands.length,
    changedPathCount: verification.git.changedPaths.length,
    timedOut: verification.commands.some((command) => command.timedOut),
    sourceAt: new Date().toISOString(),
  });
  phaseEvent(
    context.onEvent,
    "phase_finished",
    "verify",
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
      status: "stop",
      result: {
        status,
        runDir: worker?.runDir ?? documenter.runDir,
        verification,
        failure: {
          phase: "verifying",
          code: status === "timed_out" ? "timed_out" : "verification_failed",
        },
      },
    };
  }
  return { status: "continue", state: { ...state, verification } };
}

async function runReviewBlock(context: BlockContext, state: BlockState): Promise<BlockOutcome> {
  const worker = state.worker;
  const documenter = state.documenter;
  const verification = state.verification;
  if (!documenter || !verification) throw new Error("review prerequisites missing");
  const primaryRun = worker ?? documenter;
  const primaryArtifacts = context.workerArtifacts;
  let patch: string;
  try {
    patch = reviewDiff(context.repo);
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
      status: "stop",
      result: {
        status: "failed",
        runDir: primaryRun.runDir,
        verification,
        failure: { phase: "reviewing", code: "agent_failed" },
      },
    };
  }

  const reviewerArtifacts = createRunArtifacts(context.issue, context.root);
  phaseEvent(context.onEvent, "phase_started", "review");
  const reviewPrompt = `Issue:\n${context.issue}\n\nAccepted plan:\n${JSON.stringify(context.plan, null, 2)}\n\nGit diff:\n${patch}\n\nDeterministic verification:\n${JSON.stringify(verification, null, 2)}\nReview implementation. Submit reviewer envelope.`;
  let reviewer: AgentRunResult;
  try {
    reviewer = await context.run({
      agent: loadAgent("reviewer"),
      cwd: context.repo,
      timeoutSeconds: context.timeoutSeconds,
      prompt: reviewPrompt,
      artifacts: reviewerArtifacts,
      envelopeRole: "reviewer",
      receiptContext: {
        baseSha: context.baseSha,
        ...(worker ? { workerRunId: worker.receipt.runId } : {}),
        documenterRunId: documenter.receipt.runId,
      },
      onActivity: context.onEvent
        ? (activity) => context.onEvent?.(activityEvent(activity, "review"))
        : undefined,
    });
  } catch (error) {
    phaseEvent(context.onEvent, "phase_finished", "review", "failed");
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
      status: "stop",
      result: {
        status: "failed",
        runDir: primaryRun.runDir,
        reviewerRunDir: reviewerArtifacts.runDir,
        verification,
        failure: { phase: "reviewing", code: "agent_failed" },
      },
    };
  }

  if (reviewer.status !== "completed" || !reviewer.envelope) {
    phaseEvent(context.onEvent, "phase_finished", "review", reviewer.status);
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
      status: "stop",
      result: {
        status: reviewer.status,
        runDir: primaryRun.runDir,
        reviewerRunDir: reviewer.runDir,
        verification,
        failure: { phase: "reviewing", code: agentFailureCode(reviewer) },
      },
    };
  }

  if (!("verdict" in reviewer.envelope)) {
    phaseEvent(context.onEvent, "phase_finished", "review", "failed");
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
      status: "stop",
      result: {
        status: "failed",
        runDir: primaryRun.runDir,
        reviewerRunDir: reviewer.runDir,
        verification,
        failure: { phase: "reviewing", code: "envelope_invalid" },
      },
    };
  }

  const envelope: ReviewerEnvelope = reviewer.envelope;
  const status: LifecycleStatus = envelope.verdict === "PASS" ? "completed" : "failed";
  context.onEvent?.({
    type: "review_finished",
    actor: "reviewer",
    phase: "reviewing",
    stepId: "review",
    verdict: envelope.verdict,
    blockerCount: envelope.blockingFindings.length,
    sourceAt: new Date().toISOString(),
  });
  phaseEvent(context.onEvent, "phase_finished", "review", status);
  const lifecycle = {
    status,
    stage: "reviewer",
    baseSha: context.baseSha,
    allowedPaths: context.allowedPaths,
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
  if (status === "completed") {
    const execution = createFeaturePrExecution({
      manifest: context.manifest,
      ...(worker ? { implementRunId: worker.receipt.runId } : {}),
      documenterRunId: documenter.receipt.runId,
      reviewerRunId: reviewer.receipt.runId,
      reviewedPatchSha256: createHash("sha256").update(patch).digest("hex"),
    });
    primaryArtifacts.writeJson("workflow-execution.json", execution);
    addArtifact(primaryArtifacts, "workflow-execution.json");
  }
  return {
    status: "stop",
    result: {
      status,
      runDir: primaryRun.runDir,
      reviewerRunDir: reviewer.runDir,
      verification,
      reviewer: envelope,
      ...(status === "failed"
        ? { failure: { phase: "reviewing" as const, code: "review_failed" as const } }
        : {}),
    },
  };
}

async function executeManifest(
  context: BlockContext,
  manifest: WorkflowManifest,
): Promise<WorkerLifecycleResult> {
  let state: BlockState = {};
  for (const step of manifest.steps) {
    if (step.status === "skipped") continue;
    let outcome: BlockOutcome;
    switch (step.id) {
      case "implement":
        outcome = await runImplementBlock(context, state);
        break;
      case "document":
        outcome = await runDocumentBlock(context, state);
        break;
      case "verify":
        outcome = await runVerifyBlock(context, state);
        break;
      case "review":
        outcome = await runReviewBlock(context, state);
        break;
    }
    if (outcome.status === "stop") return outcome.result;
    state = outcome.state;
  }
  throw new Error("workflow finished without a terminal block");
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
  let manifest: WorkflowManifest;
  try {
    plan = readPlanner(options.plannerEnvelope);
    const plannerRunId = plannerRunIdFromEnvelopePath(options.plannerEnvelope);
    manifest = options.workflowManifest
      ? readWorkflowManifest(options.workflowManifest)
      : createFeaturePrManifest({
          plannerRunId,
          baseSha: options.baseSha,
          plan,
        });
    assertFeaturePrManifest(manifest, {
      plannerRunId,
      baseSha: options.baseSha,
      plan,
    });
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

  const implementPaths = manifest.allowedPaths.filter((path) => !isDocumentationPath(path));
  return executeManifest(
    {
      repo: options.repo,
      issue,
      plan,
      baseSha: options.baseSha,
      timeoutSeconds: options.timeoutSeconds,
      ...(options.root ? { root: options.root } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      run: options.runAgent ?? runAgent,
      verify: options.verifyRepository ?? verifyRepository,
      allowedPaths: manifest.allowedPaths,
      implementPaths,
      workerArtifacts,
      manifest,
    },
    manifest,
  );
}
