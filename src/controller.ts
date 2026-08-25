import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { parseAgentDefinition } from "./agents/index.js";
import { harvest } from "./runs/evidence.js";
import { createIntake } from "./intake.js";
import {
  createLinearDecisionComment,
  LinearIssueValidationError,
  type LinearDecisionReply,
  type LinearDecisionRequest as LinearDecisionThreadRequest,
} from "./integrations/linear.js";
import {
  createGitHubPublicationDryRun,
  publishGitHubPullRequest,
  type GitHubPublication,
  type GitHubPublicationDryRun,
  type GitHubPublicationOptions,
} from "./integrations/github.js";
import { parseEnvelope, type EnvelopeParseResult, type PlannerEnvelope } from "./envelope.js";
import {
  assertFeaturePrExecution,
  completedExecutionRunIds,
  completedStepRunId,
  parseWorkflowExecution,
} from "./workflows/execution.js";
import { featurePrRemoteStepsFromManifest } from "./workflows/feature-pr.js";
import { createFeaturePrManifest, featurePrDefinitionSha256 } from "./workflows/manifest.js";
import { FEATURE_PR_WORKFLOW_ID, FEATURE_PR_WORKFLOW_VERSION } from "./workflows/feature-pr.js";
import { ExeClient, ExeCommandError } from "./integrations/exe.js";
import {
  beginControllerDecisionWait,
  completeControllerWorkflow,
  createControllerState,
  isControllerStateV2,
  pinControllerWorkflowManifest,
  readControllerState,
  recordControllerCleanup,
  recordControllerVm,
  recordControllerWorkflowStep,
  replaceControllerDecisionVm,
  recoverStaleControllerClaims,
  scanRecoverableControllerStates,
  transitionControllerState,
  type CleanupState,
  type ControllerState,
} from "./run-state.js";
import { acquireControllerLock, linuxProcessIdentity } from "./controller-lock.js";
import {
  RemoteProtocolParser,
  type RemoteEvent,
  type RemoteFailure,
  type RemoteResultFrame,
} from "./remote-protocol.js";
import { workflowStep, type WorkflowStepDescriptor, type WorkflowStepId } from "./workflow-step.js";
import {
  createTelemetryWriter,
  readTelemetry,
  sanitizeTelemetryText,
  telemetryPath,
  type TelemetryInput,
  type TelemetryWriter,
} from "./telemetry.js";

const REMOTE_MAQUILA = "/home/exedev/maquila";
const REMOTE_WORK = "/home/exedev/work";
const REMOTE_NODE = "/home/exedev/.local/node/bin/node";
const REMOTE_NPM = "/home/exedev/.local/node/bin/npm";
const REMOTE_BUN = "/home/exedev/.local/bun/bin/bun";
const REMOTE_PATH =
  "/home/exedev/.local/bun/bin:/home/exedev/.local/node/bin:/usr/local/bin:/usr/bin:/bin";
const NODE_VERSION = "24.15.0";
const BUN_VERSION = "1.3.14";
const NODE_CHECKSUMS: Record<string, string> = {
  x64: "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6",
  arm64: "f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0",
};
const MAX_PATCH = 1_000_000;
const MAX_EVIDENCE_ARCHIVE = 50 * 1024 * 1024;
const MAX_SESSION_CHECKPOINT = 8 * 1024 * 1024;
const REMOTE_RUN = `${REMOTE_MAQUILA}/.maquila/runs/`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type RemotePhase = RemoteEvent["phase"];
function telemetryPhase(
  stepId: WorkflowStepId,
  attempt = 1,
): { id: string; name: RemotePhase; stepId: WorkflowStepId; attempt: number } {
  const { phase } = workflowStep(stepId);
  return { id: `${stepId}:${attempt}`, name: phase, stepId, attempt };
}

export interface ControllerOptions {
  issue: string;
  owner: string;
  repo: string;
  baseRef: string;
  tag: string;
  identity?: string;
  timeoutSeconds: number;
  linearToken: string;
  githubToken: string;
  openRouterKey: string;
  root?: string;
  maquilaRoot?: string;
  exe?: ControllerExe;
  intake?: typeof createIntake;
  sleep?: (milliseconds: number) => Promise<void>;
  runId?: string;
  telemetry?: typeof createTelemetryWriter;
  publish?: typeof publishGitHubPullRequest;
  publicationMode?: "publish" | "dry-run";
  onAccepted?: () => void;
  heartbeatMilliseconds?: number;
  decision?: ControllerDecisionContext;
  createDecisionComment?: typeof createLinearDecisionComment;
  inlineDecisionWaiter?: (
    request: ControllerDecisionRequest,
    expiresAt: string,
  ) => Promise<LinearDecisionReply>;
  /** Internal entry used by `maquila run resume`; never accepted from remote input. */
  resumeExisting?: boolean;
}
export interface ControllerDecisionContext extends LinearDecisionReply {
  previousRunId: string;
  requestCommentId: string;
}
export interface ControllerDecisionRequest extends LinearDecisionThreadRequest {
  runId: string;
  continuationRunId: string;
  issue: string;
  owner: string;
  repo: string;
  baseRef: string;
  tag: string;
  timeoutSeconds: number;
}
export interface ControllerExe {
  createVm(options: {
    name: string;
    tag: string;
    integration?: string;
  }): Promise<{ vmName: string; status: string; sshDest: string }>;
  destroyVm(name: string): Promise<{ destroyed: boolean; notFound: boolean }>;
  exec(
    destination: string,
    argv: string[],
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string }>;
  execStream(
    destination: string,
    argv: string[],
    onStdout: (chunk: Buffer) => void,
    timeoutMs?: number,
  ): Promise<{ stderr: string }>;
  copyTo(destination: string, localPath: string, remotePath: string): Promise<unknown>;
  copyFrom(destination: string, remotePath: string, localPath: string): Promise<unknown>;
}
export interface ControllerResult {
  status: "awaiting_decision" | "cancelled" | "completed" | "failed";
  runDir: string;
  pullRequest?: GitHubPublication;
  publicationDryRun?: GitHubPublicationDryRun;
  decisionRequest?: ControllerDecisionRequest;
  error?: string;
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function requireAbsolute(path: string): string {
  if (!isAbsolute(path)) throw new Error("identity must be absolute");
  return path;
}
function vmName(runId: string): string {
  return `maquila-${runId.replaceAll("-", "").slice(0, 24)}`;
}
function outputPath(path: string | undefined, label: string): string {
  if (!path?.startsWith(REMOTE_RUN) || !UUID.test(path.slice(REMOTE_RUN.length))) {
    throw new Error(`remote ${label.toLowerCase()} missing`);
  }
  return path;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function safeRepo(owner: string, repo: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error("invalid repository");
  return `${owner}/${repo}`;
}
function writeJson(path: string, value: object): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
function readdirArtifacts(runDir: string): string[] {
  return readdirSync(runDir);
}
function assertSecretAbsent(value: string | Buffer, secrets: string[]): void {
  if (secrets.some((secret) => secret && value.includes(secret)))
    throw new Error("secret detected in retained artifact");
}
function assertArtifactSafe(path: string, secrets: string[], label: string): void {
  if (statSync(path).size > MAX_EVIDENCE_ARCHIVE) {
    rmSync(path, { force: true });
    throw new Error(`${label} exceeds limit`);
  }
  try {
    assertSecretAbsent(readFileSync(path), secrets);
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}
export { harvest, type HarvestExpectations } from "./runs/evidence.js";

export function archiveMaquila(maquilaRoot: string): {
  path: string;
  sha: string;
  cleanup(): void;
} {
  const directory = mkdtempSync(resolve(tmpdir(), "maquila-runtime-"));
  const path = resolve(directory, "runtime.tar");
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: maquilaRoot,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["archive", "--format=tar", `--output=${path}`, "HEAD"], {
      cwd: maquilaRoot,
    });
    chmodSync(path, 0o600);
    return { path, sha, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

class PlannerDecisionRequired extends Error {
  constructor(readonly request: ControllerDecisionRequest) {
    super("planner decision required");
  }
}

function remoteFailureMessage(failure: RemoteFailure): string {
  const detail: Record<RemoteFailure["code"], string> = {
    model_request_failed: "model request failed",
    envelope_invalid: "agent did not submit a valid envelope",
    ownership_failed: "agent changed paths outside its approved ownership",
    verification_failed: "deterministic verification failed",
    review_failed: "independent review found blocking issues",
    timed_out: "phase timed out",
    agent_failed: "agent execution failed",
  };
  return `${failure.phase}: ${detail[failure.code]}`;
}

function validateDecision(value: ControllerDecisionContext | undefined): void {
  if (!value) return;
  if (
    !UUID.test(value.previousRunId) ||
    !value.requestCommentId.trim() ||
    !value.commentId.trim() ||
    !value.body.trim() ||
    value.body.length > 4000 ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    createHash("sha256")
      .update(
        JSON.stringify({
          commentId: value.commentId,
          body: value.body,
          createdAt: value.createdAt,
        }),
      )
      .digest("hex") !== value.sha256
  )
    throw new Error("invalid controller decision context");
}

export interface PersistedDecisionRequest {
  request: ControllerDecisionRequest;
  generation: number;
  expiresAt: string;
  assigneeId: string;
}

export function readPersistedDecisionRequest(runDir: string): PersistedDecisionRequest {
  const value: unknown = JSON.parse(readFileSync(resolve(runDir, "decision-request.json"), "utf8"));
  if (!isRecord(value)) throw new Error("invalid persisted decision request");
  const request = {
    runId: stringValue(value.runId),
    commentId: stringValue(value.commentId),
    commentUrl: stringValue(value.commentUrl),
    issueId: stringValue(value.issueId),
    assigneeId: stringValue(value.assigneeId),
    generation: typeof value.generation === "number" ? value.generation : Number.NaN,
    questionSha256: stringValue(value.questionSha256),
    questionCount: typeof value.questionCount === "number" ? value.questionCount : Number.NaN,
    requestedAt: stringValue(value.requestedAt),
    marker: stringValue(value.marker),
    continuationRunId: stringValue(value.continuationRunId),
    issue: stringValue(value.issue),
    owner: stringValue(value.owner),
    repo: stringValue(value.repo),
    baseRef: stringValue(value.baseRef),
    tag: stringValue(value.tag),
    timeoutSeconds: typeof value.timeoutSeconds === "number" ? value.timeoutSeconds : Number.NaN,
  };
  if (
    !UUID.test(request.runId) ||
    request.continuationRunId !== request.runId ||
    !request.commentId ||
    !request.commentUrl.startsWith("https://linear.app/") ||
    !request.issueId ||
    !request.assigneeId ||
    !Number.isInteger(request.generation) ||
    request.generation < 1 ||
    request.generation > 3 ||
    !/^[0-9a-f]{64}$/.test(request.questionSha256) ||
    !Number.isInteger(request.questionCount) ||
    request.questionCount < 1 ||
    request.questionCount > 10 ||
    !Number.isFinite(Date.parse(request.requestedAt)) ||
    !request.marker ||
    !request.issue ||
    !request.owner ||
    !request.repo ||
    !request.baseRef ||
    !request.tag ||
    !Number.isInteger(request.timeoutSeconds) ||
    !Number.isInteger(value.generation) ||
    Number(value.generation) < 1 ||
    Number(value.generation) > 3 ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    typeof value.assigneeId !== "string" ||
    !value.assigneeId.trim()
  )
    throw new Error("invalid persisted decision request");
  return {
    request,
    generation: Number(value.generation),
    expiresAt: value.expiresAt,
    assigneeId: value.assigneeId,
  };
}

function publicFailureDetail(error: unknown): string | undefined {
  if (error instanceof LinearIssueValidationError) return error.message;
  if (error instanceof ExeCommandError) {
    if (error.timedOut) return `${error.operation} timed out`;
    return error.exitCode === null
      ? `${error.operation} failed`
      : `${error.operation} exited with code ${error.exitCode}`;
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^E[A-Z0-9_]+$/.test(code)) return `local error ${code}`;
  }
  return undefined;
}

async function remote(
  exe: ControllerExe,
  destination: string,
  argv: string[],
  timeout: number,
): Promise<string> {
  return (await exe.exec(destination, argv, timeout)).stdout;
}
async function streamed(
  exe: ControllerExe,
  destination: string,
  argv: string[],
  timeout: number,
  onEvent: (event: RemoteEvent) => void,
): Promise<RemoteResultFrame> {
  const parser = new RemoteProtocolParser(onEvent);
  await exe.execStream(destination, argv, (chunk) => parser.push(chunk), timeout);
  return parser.finish();
}

function acquireDecisionResumeLease(runDir: string): () => void {
  const path = resolve(runDir, "decision-resume-owner.json");
  const claim = (): void => {
    const processIdentity = linuxProcessIdentity(process.pid);
    if (!processIdentity) throw new Error("controller process identity unavailable");
    try {
      writeFileSync(
        path,
        `${JSON.stringify({ version: 1, pid: process.pid, processIdentity })}\n`,
        { mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      let owner: unknown;
      try {
        owner = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        owner = undefined;
      }
      if (
        isRecord(owner) &&
        typeof owner.pid === "number" &&
        typeof owner.processIdentity === "string" &&
        linuxProcessIdentity(owner.pid) === owner.processIdentity
      )
        throw new Error("decision resume is already active", { cause: error });
      rmSync(path, { force: true });
      writeFileSync(
        path,
        `${JSON.stringify({ version: 1, pid: process.pid, processIdentity })}\n`,
        { mode: 0o600, flag: "wx" },
      );
    }
  };
  claim();
  return () => rmSync(path, { force: true });
}

interface AttemptRecoveryRecord {
  version: 1;
  runId: string;
  pid: number;
  processIdentity: string;
  startedAt: string;
}
function readAttemptRecovery(path: string): AttemptRecoveryRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      isRecord(value) &&
      value.version === 1 &&
      typeof value.runId === "string" &&
      UUID.test(value.runId) &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.processIdentity === "string" &&
      value.processIdentity.length > 0 &&
      typeof value.startedAt === "string" &&
      Number.isFinite(Date.parse(value.startedAt))
    )
      return {
        version: 1,
        runId: value.runId,
        pid: value.pid,
        processIdentity: value.processIdentity,
        startedAt: value.startedAt,
      };
  } catch {}
  return undefined;
}
/** Reconciles accepted children that died before strict intake state existed. */
export function recoverAbandonedAttempts(root: string): void {
  const attempts = resolve(root, ".maquila", "attempts");
  if (!existsSync(attempts)) return;
  for (const entry of readdirSync(attempts, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const directory = resolve(attempts, entry.name);
    const attempt = readAttemptRecovery(resolve(directory, "recovery.json"));
    if (!attempt || attempt.runId !== entry.name) continue; // corrupt records stay conservative.
    let alive = false;
    try {
      process.kill(attempt.pid, 0);
      alive = linuxProcessIdentity(attempt.pid) === attempt.processIdentity;
    } catch {}
    if (alive) continue;
    try {
      const telemetry = createTelemetryWriter(root, attempt.runId);
      const terminal = readTelemetry(telemetry.path).some((event) => event.type === "run_finished");
      if (!terminal) {
        telemetry.append({
          type: "failure",
          actor: "controller",
          payload: { stage: "recovery", message: "abandoned accepted run" },
        });
        telemetry.append({
          type: "run_finished",
          actor: "controller",
          payload: { status: "failed", cleanup: "not-needed" },
        });
      }
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Keep record for later recovery when telemetry storage becomes available.
    }
  }
}

async function recover(root: string, exe: ControllerExe): Promise<void> {
  recoverAbandonedAttempts(root);
  const controllers = resolve(root, ".maquila", "controllers");
  if (!existsSync(controllers)) return;
  recoverStaleControllerClaims(controllers);
  for (const state of scanRecoverableControllerStates(controllers)) {
    const expiredDecisionWait =
      state.state === "awaiting_decision" &&
      state.decisionWait !== undefined &&
      Date.now() >= Date.parse(state.decisionWait.expiresAt);
    // A persisted, unexpired decision wait intentionally survives controller restarts.
    if (state.state === "awaiting_decision" && state.decisionWait && !expiredDecisionWait) continue;
    const runDir = resolve(controllers, state.runId);
    const name =
      state.vm?.name ?? (state.state === "creating_vm" ? vmName(state.runId) : undefined);
    let cleanup = state.cleanup;
    if (state.vm && expiredDecisionWait) {
      try {
        await remote(
          exe,
          state.vm.sshDest,
          ["rm", "-f", "/home/exedev/.pi/agent/models.json"],
          30_000,
        );
      } catch {}
    }
    if (name) {
      const result = await exe.destroyVm(name);
      if (!result.destroyed && !result.notFound)
        throw new Error("controller recovery cleanup failed");
      cleanup = "complete";
      recordControllerCleanup(runDir, "complete");
    }
    transitionControllerState(runDir, expiredDecisionWait ? "cancelled" : "failed");

    // Cleanup authority wins over observability: corrupt or unavailable telemetry
    // must never strand a VM during recovery.
    try {
      const path = telemetryPath(root, state.runId);
      if (!existsSync(path)) continue;
      const terminal = readTelemetry(path).some((event) => event.type === "run_finished");
      const telemetry = createTelemetryWriter(root, state.runId);
      if (terminal) {
        if (cleanup === "complete" && state.cleanup !== "complete")
          telemetry.append({
            type: "cleanup_updated",
            actor: "controller",
            payload: { cleanup: "complete" },
          });
        continue;
      }
      if (cleanup === "complete" && state.cleanup !== "complete")
        telemetry.append({
          type: "cleanup_updated",
          actor: "controller",
          payload: { cleanup: "complete" },
        });
      if (!expiredDecisionWait)
        telemetry.append({
          type: "failure",
          actor: "controller",
          payload: { stage: "recovery", message: "abandoned controller run" },
        });
      telemetry.append({
        type: "run_finished",
        actor: "controller",
        payload: {
          status: expiredDecisionWait ? "cancelled" : "failed",
          cleanup,
          ...(expiredDecisionWait ? { reason: "decision_expired" } : {}),
        },
      });
      if (expiredDecisionWait)
        writeJson(resolve(runDir, "receipt.json"), {
          kind: "controller",
          status: "cancelled",
          stage: "decision_expired",
          startedAt: state.createdAt,
          finishedAt: new Date().toISOString(),
          cleanup,
          artifacts: readdirArtifacts(runDir),
        });
    } catch {}
  }
}

export async function runController(options: ControllerOptions): Promise<ControllerResult> {
  if (
    !Number.isInteger(options.timeoutSeconds) ||
    options.timeoutSeconds < 1 ||
    options.timeoutSeconds > 1800
  )
    throw new Error("timeoutSeconds must be an integer from 1 to 1800");
  if (!options.linearToken.trim()) throw new Error("Linear token missing");
  if (!options.githubToken.trim()) throw new Error("GitHub token missing");
  if (!options.openRouterKey.trim()) throw new Error("OpenRouter key missing");
  if (options.publicationMode === "dry-run" && options.publish)
    throw new Error("dry-run publication cannot use a publisher");
  if (options.identity) requireAbsolute(options.identity);
  validateDecision(options.decision);
  safeRepo(options.owner, options.repo);
  const root = resolve(options.root ?? process.cwd());
  const maquilaRoot = resolve(options.maquilaRoot ?? process.cwd());
  const exe = options.exe ?? new ExeClient(undefined, 30_000, options.identity);
  let lock = acquireControllerLock(root);
  const runId = options.runId ?? randomUUID();
  const provisional = resolve(root, ".maquila", "attempts", runId);
  const startedAt = new Date().toISOString();
  let telemetry: TelemetryWriter;
  let telemetryBroken = false;
  let failure: string | undefined;
  try {
    telemetry = (options.telemetry ?? createTelemetryWriter)(root, runId);
    if (!options.resumeExisting) {
      telemetry.append({
        type: "run_created",
        actor: "controller",
        payload: { status: "created" },
      });
      telemetry.append({
        type: "run_started",
        actor: "controller",
        payload: { status: "running" },
      });
      mkdirSync(provisional, { recursive: true, mode: 0o700 });
      const processIdentity = linuxProcessIdentity(process.pid);
      if (!processIdentity) throw new Error("controller process identity unavailable");
      writeJson(resolve(provisional, "recovery.json"), {
        version: 1,
        runId,
        pid: process.pid,
        processIdentity,
        startedAt,
      } satisfies AttemptRecoveryRecord);
      writeJson(resolve(provisional, "receipt.json"), {
        kind: "controller",
        status: "failed",
        startedAt,
        artifacts: ["receipt.json"],
      });
      options.onAccepted?.();
    }
  } catch (error) {
    lock.release();
    throw error;
  }
  let evidenceDir = provisional;
  let state: ControllerState | undefined;
  let archive: ReturnType<typeof archiveMaquila> | undefined;
  let intakeSnapshot: Awaited<ReturnType<typeof createIntake>> | undefined;
  let decisionRequest: ControllerDecisionRequest | undefined;
  let reviewedPatchSha256: string | undefined;
  let cleanupFailed = false;
  let cleanupOutcome: CleanupState = "not-needed";
  let stage = "recovery";
  let publicFailureMessage = "controller stage failed";
  const emit = (input: TelemetryInput): void => {
    if (telemetryBroken) throw new Error("telemetry unavailable");
    try {
      telemetry.append(input);
    } catch (error) {
      telemetryBroken = true;
      throw new Error("telemetry append failed", { cause: error });
    }
  };
  const bestEffortEmit = (input: TelemetryInput): void => {
    if (telemetryBroken) return;
    try {
      telemetry.append(input);
    } catch {
      telemetryBroken = true;
    }
  };
  const heartbeatMilliseconds = options.heartbeatMilliseconds ?? 10_000;
  if (!Number.isInteger(heartbeatMilliseconds) || heartbeatMilliseconds < 1) {
    lock.release();
    throw new Error("heartbeatMilliseconds must be a positive integer");
  }
  let heartbeatStopped = false;
  const heartbeat = setInterval(() => {
    const phase =
      state && isControllerStateV2(state) && state.state === "executing"
        ? state.workflow.currentStepId && state.workflow.attempt
          ? {
              id: `${workflowStep(state.workflow.currentStepId).phase}:${state.workflow.attempt}`,
              name: workflowStep(state.workflow.currentStepId).phase,
              attempt: state.workflow.attempt,
            }
          : undefined
        : state && state.state !== "executing"
          ? { id: `${state.state}:1`, name: state.state, attempt: 1 as const }
          : undefined;
    bestEffortEmit({
      type: "heartbeat",
      actor: "controller",
      ...(phase ? { phase } : {}),
      payload: {},
    });
  }, heartbeatMilliseconds);
  heartbeat.unref();
  const stopHeartbeat = (): void => {
    if (heartbeatStopped) return;
    heartbeatStopped = true;
    clearInterval(heartbeat);
  };
  let openHostPhase:
    | "creating_vm"
    | "bootstrapping"
    | "ready_for_publication"
    | "publishing"
    | undefined;
  const closeHostPhase = (status: "completed" | "failed" = "completed"): void => {
    if (!openHostPhase) return;
    emit({
      type: "phase_finished",
      actor: "controller",
      phase: { id: `${openHostPhase}:1`, name: openHostPhase, attempt: 1 },
      payload: { status },
    });
    openHostPhase = undefined;
  };
  const advance = (
    runDir: string,
    next: Parameters<typeof transitionControllerState>[1],
    actor: TelemetryInput["actor"] = "controller",
    sourceAt?: string,
    attempt = 1,
    stepId?: WorkflowStepId,
  ): ControllerState => {
    closeHostPhase();
    let nextState: ControllerState;
    if (stepId && state && isControllerStateV2(state)) {
      if (state.state === "bootstrapping") state = transitionControllerState(runDir, "executing");
      nextState = recordControllerWorkflowStep(runDir, stepId, attempt);
    } else {
      nextState = state?.state === next ? state : transitionControllerState(runDir, next);
    }
    state = nextState;
    emit({
      type: "phase_started",
      actor,
      phase: stepId
        ? telemetryPhase(stepId, attempt)
        : next === "executing"
          ? undefined
          : { id: `${next}:${attempt}`, name: next, attempt },
      ...(sourceAt ? { sourceAt } : {}),
      payload: {},
    });
    if (
      next === "creating_vm" ||
      next === "bootstrapping" ||
      next === "ready_for_publication" ||
      next === "publishing"
    )
      openHostPhase = next;
    stage = next;
    publicFailureMessage = "controller stage failed";
    return nextState;
  };
  try {
    await recover(root, exe);
    stage = "intake";
    const runDir = resolve(root, ".maquila", "controllers", runId);
    let vm: { vmName: string; sshDest: string; status: string };
    let initialPlannerAttempt = 1;
    let initialResumeSession: { sessionId: string; sha256: string } | undefined;
    let replacementVm = false;
    const resuming = options.resumeExisting === true;
    const intake = await (options.intake ?? createIntake)(
      { token: options.linearToken, issue: options.issue },
      {
        token: options.githubToken,
        owner: options.owner,
        repo: options.repo,
        baseRef: options.baseRef,
      },
    );
    if (resuming) {
      state = readControllerState(runDir);
      let persisted: PersistedDecisionRequest;
      try {
        persisted = readPersistedDecisionRequest(runDir);
      } catch (error) {
        if (state.state === "awaiting_decision" && state.decisionWait)
          state = transitionControllerState(runDir, "failed");
        throw error;
      }
      const wait = state.decisionWait;
      if (
        state.runId !== runId ||
        state.state !== "awaiting_decision" ||
        state.cleanup !== "pending" ||
        !state.vm ||
        !wait ||
        persisted.request.runId !== runId ||
        persisted.request.issue !== options.issue ||
        persisted.request.owner !== options.owner ||
        persisted.request.repo !== options.repo ||
        persisted.request.baseRef !== options.baseRef ||
        persisted.request.tag !== options.tag ||
        persisted.generation !== wait.generation ||
        persisted.expiresAt !== wait.expiresAt ||
        Date.now() >= Date.parse(wait.expiresAt)
      ) {
        if (state.state === "awaiting_decision" && state.decisionWait)
          state = transitionControllerState(runDir, "failed");
        throw new Error("controller decision wait is not resumable");
      }
      const checkpoint = resolve(runDir, "planner-session.jsonl");
      if (
        !existsSync(checkpoint) ||
        statSync(checkpoint).size > MAX_SESSION_CHECKPOINT ||
        hash(checkpoint) !== wait.checkpointSha256
      ) {
        state = transitionControllerState(runDir, "failed");
        throw new Error("planner session checkpoint is invalid");
      }
      assertSecretAbsent(readFileSync(checkpoint), [options.openRouterKey]);
      if (
        intake.issue.snapshotSha256 !== state.issueSnapshotSha256 ||
        intake.repository.snapshotSha256 !== state.repositorySnapshotSha256 ||
        intake.repository.baseSha !== state.baseSha
      ) {
        state = transitionControllerState(runDir, "failed");
        throw new Error("decision wait input drifted");
      }
      if (!options.inlineDecisionWaiter) throw new Error("decision resume waiter missing");
      evidenceDir = runDir;
      cleanupOutcome = "pending";
      let releaseResumeLease: () => void;
      try {
        releaseResumeLease = acquireDecisionResumeLease(runDir);
      } catch {
        decisionRequest = persisted.request;
        throw new PlannerDecisionRequired(persisted.request);
      }
      lock.release();
      let decision: LinearDecisionReply;
      try {
        decision = await options.inlineDecisionWaiter(persisted.request, wait.expiresAt);
      } catch (error) {
        releaseResumeLease();
        lock = acquireControllerLock(root);
        state = transitionControllerState(
          runDir,
          Date.now() >= Date.parse(wait.expiresAt) ? "cancelled" : "failed",
        );
        throw error;
      }
      lock = acquireControllerLock(root);
      releaseResumeLease();
      if (
        Date.now() >= Date.parse(wait.expiresAt) ||
        Date.parse(decision.createdAt) > Date.parse(wait.expiresAt)
      ) {
        state = transitionControllerState(runDir, "cancelled");
        throw new Error("decision wait expired");
      }
      const refreshed = await (options.intake ?? createIntake)(
        { token: options.linearToken, issue: options.issue },
        {
          token: options.githubToken,
          owner: options.owner,
          repo: options.repo,
          baseRef: options.baseRef,
        },
      );
      if (
        refreshed.issue.snapshotSha256 !== state.issueSnapshotSha256 ||
        refreshed.repository.snapshotSha256 !== state.repositorySnapshotSha256 ||
        refreshed.repository.baseSha !== state.baseSha
      ) {
        state = transitionControllerState(runDir, "failed");
        throw new Error("decision wait input drifted");
      }
      const current = readControllerState(runDir);
      if (current.updatedAt !== state.updatedAt || current.state !== "awaiting_decision")
        throw new Error("decision wait changed while accepting reply");
      try {
        await remote(exe, current.vm!.sshDest, ["true"], 30_000);
      } catch {
        const replacementPath = resolve(runDir, "decision-vm-replacement.json");
        writeFileSync(
          replacementPath,
          `${JSON.stringify({ version: 1, attemptedAt: new Date().toISOString() })}\n`,
          { mode: 0o600, flag: "wx" },
        );
        await exe.destroyVm(current.vm!.name).catch(() => ({ destroyed: false, notFound: true }));
        const replacement = await exe.createVm({ name: vmName(runId), tag: options.tag });
        state = replaceControllerDecisionVm(runDir, {
          name: replacement.vmName,
          sshDest: replacement.sshDest,
          status: replacement.status,
        });
        vm = replacement;
        replacementVm = true;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          try {
            await remote(exe, vm.sshDest, ["true"], 30_000);
            break;
          } catch (error) {
            if (attempt === 11) throw error;
            await (
              options.sleep ??
              ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)))
            )(5_000);
          }
        }
        await remote(
          exe,
          vm.sshDest,
          [
            "git",
            "clone",
            `https://github.int.exe.xyz/${state.repositoryFullName}.git`,
            REMOTE_WORK,
          ],
          120_000,
        );
        await remote(
          exe,
          vm.sshDest,
          ["git", "-C", REMOTE_WORK, "checkout", "--detach", state.baseSha],
          30_000,
        );
      }
      vm = { vmName: state.vm!.name, sshDest: state.vm!.sshDest, status: state.vm!.status };
      if (
        (
          await remote(exe, vm.sshDest, ["git", "-C", REMOTE_WORK, "rev-parse", "HEAD"], 30_000)
        ).trim() !== state.baseSha ||
        (
          await remote(exe, vm.sshDest, ["git", "-C", REMOTE_WORK, "status", "--porcelain"], 30_000)
        ).trim()
      )
        throw new Error("retained decision workspace changed");
      if (!replacementVm)
        await remote(exe, vm.sshDest, ["test", "-x", `${REMOTE_MAQUILA}/dist/maquila`], 30_000);
      writeJson(resolve(runDir, "decision-accepted.json"), {
        version: 1,
        generation: wait.generation,
        requestCommentId: persisted.request.commentId,
        decision,
      });
      const localIssue = resolve(runDir, "issue.md");
      writeFileSync(
        localIssue,
        `${readFileSync(localIssue, "utf8").trimEnd()}\n\n## Engineer decision ${wait.generation}\n\n${decision.body}\n`,
        { mode: 0o600 },
      );
      state = transitionControllerState(
        runDir,
        isControllerStateV2(state) ? "executing" : "planning",
      );
      emit({
        type: "phase_finished",
        actor: "controller",
        phase: {
          id: `awaiting_decision:${wait.generation}`,
          name: "awaiting_decision",
          attempt: wait.generation,
        },
        payload: { status: "completed" },
      });
      vm = { vmName: state.vm!.name, sshDest: state.vm!.sshDest, status: state.vm!.status };
      initialPlannerAttempt = wait.generation + 1;
      initialResumeSession = { sessionId: wait.plannerSessionId, sha256: wait.checkpointSha256 };
      intakeSnapshot = { ...intake, idempotencyKey: state.idempotencyKey };
    } else {
      const idempotencyKey = options.decision
        ? createHash("sha256")
            .update(`${intake.idempotencyKey}:${options.decision.sha256}`)
            .digest("hex")
        : intake.idempotencyKey;
      intakeSnapshot = { ...intake, idempotencyKey };
      const decisionContext = options.decision
        ? `\n\n## Human decision\n\nLinear reply ${options.decision.commentId}:\n${options.decision.body}\n`
        : "";
      writeFileSync(
        resolve(provisional, "issue.md"),
        `${intake.issue.title}\n\n${intake.issue.description}${decisionContext}\n`,
        { mode: 0o600 },
      );
      writeJson(resolve(provisional, "intake.json"), {
        issue: intake.issue,
        repository: intake.repository,
        idempotencyKey,
        ...(options.decision ? { decision: options.decision } : {}),
      });
      stage = "state";
      state = createControllerState(runDir, {
        runId: basename(runDir),
        workflow: {
          id: FEATURE_PR_WORKFLOW_ID,
          version: FEATURE_PR_WORKFLOW_VERSION,
          definitionSha256: featurePrDefinitionSha256(),
        },
        idempotencyKey,
        issueUuid: intake.issue.uuid,
        issueSnapshotSha256: intake.issue.snapshotSha256,
        repositoryId: intake.repository.repositoryId,
        repositoryFullName: intake.repository.fullName,
        repositorySnapshotSha256: intake.repository.snapshotSha256,
        baseRef: intake.repository.baseRef,
        baseSha: intake.repository.baseSha,
      });
      for (const name of ["receipt.json", "issue.md", "intake.json"])
        renameSync(resolve(provisional, name), resolve(runDir, name));
      rmSync(provisional, { recursive: true, force: true });
      evidenceDir = runDir;
      advance(runDir, "creating_vm");
      vm = await exe.createVm({ name: vmName(state.runId), tag: options.tag });
      state = recordControllerVm(runDir, {
        name: vm.vmName,
        sshDest: vm.sshDest,
        status: vm.status,
      });
      cleanupOutcome = "pending";
      emit({ type: "cleanup_updated", actor: "controller", payload: { cleanup: "pending" } });
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          await remote(exe, vm.sshDest, ["true"], 30_000);
          break;
        } catch (error) {
          if (attempt === 11) throw error;
          await (
            options.sleep ??
            ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)))
          )(5_000);
        }
      }
      advance(runDir, "bootstrapping");
      publicFailureMessage = "repository clone failed";
      if (!intakeSnapshot) throw new Error("repository intake snapshot missing");
      const cloneHost = intakeSnapshot.repository.private ? "github.int.exe.xyz" : "github.com";
      await remote(
        exe,
        vm.sshDest,
        ["git", "clone", `https://${cloneHost}/${state.repositoryFullName}.git`, REMOTE_WORK],
        120_000,
      );
      publicFailureMessage = "repository checkout failed";
      await remote(
        exe,
        vm.sshDest,
        ["git", "-C", REMOTE_WORK, "checkout", "--detach", state.baseSha],
        30_000,
      );
      if (
        (
          await remote(exe, vm.sshDest, ["git", "-C", REMOTE_WORK, "rev-parse", "HEAD"], 30_000)
        ).trim() !== state.baseSha
      )
        throw new Error("remote checkout SHA mismatch");
    }
    publicFailureMessage = "runtime archive creation failed";
    archive = archiveMaquila(maquilaRoot);
    const runtimePath = resolve(runDir, "runtime.json");
    if (resuming) {
      const runtime: unknown = JSON.parse(readFileSync(runtimePath, "utf8"));
      if (
        !isRecord(runtime) ||
        runtime.maquilaSha !== archive.sha ||
        runtime.sha256 !== hash(archive.path)
      )
        throw new Error("controller runtime changed during decision wait");
    } else {
      writeJson(runtimePath, { maquilaSha: archive.sha, sha256: hash(archive.path) });
    }
    const archivedRole = (role: "planner" | "worker" | "documenter" | "reviewer") => {
      const filePath = `src/agents/${role}.md`;
      const source = execFileSync("git", ["show", `${archive!.sha}:${filePath}`], {
        cwd: maquilaRoot,
        encoding: "utf8",
      });
      return parseAgentDefinition(source, filePath);
    };
    const archivedRoles = {
      planner: archivedRole("planner"),
      worker: archivedRole("worker"),
      documenter: archivedRole("documenter"),
      reviewer: archivedRole("reviewer"),
    };
    const configDir = mkdtempSync(resolve(tmpdir(), "maquila-pi-"));
    try {
      const models = resolve(configDir, "models.json");
      writeJson(models, { providers: { openrouter: { apiKey: options.openRouterKey } } });
      chmodSync(models, 0o600);
      if (resuming && !replacementVm) {
        await remote(exe, vm.sshDest, ["true"], 30_000);
        if (
          (
            await remote(exe, vm.sshDest, ["git", "-C", REMOTE_WORK, "rev-parse", "HEAD"], 30_000)
          ).trim() !== state.baseSha
        )
          throw new Error("retained VM checkout changed");
        await exe.copyTo(vm.sshDest, models, "/home/exedev/.pi/agent/models.json");
        await remote(
          exe,
          vm.sshDest,
          ["chmod", "600", "/home/exedev/.pi/agent/models.json"],
          30_000,
        );
      } else {
        publicFailureMessage = "bootstrap architecture detection failed";
        const machine = (await remote(exe, vm.sshDest, ["uname", "-m"], 30_000)).trim();
        const nodeArch = machine === "x86_64" ? "x64" : machine === "aarch64" ? "arm64" : "";
        const checksum = NODE_CHECKSUMS[nodeArch];
        if (!checksum) throw new Error("unsupported exe.dev architecture");
        const nodeArchive = `/home/exedev/node-v${NODE_VERSION}-linux-${nodeArch}.tar.xz`;
        publicFailureMessage = "bootstrap directory initialization failed";
        await remote(
          exe,
          vm.sshDest,
          [
            "mkdir",
            "-p",
            REMOTE_MAQUILA,
            "/home/exedev/.pi/agent",
            "/home/exedev/.local/node",
            "/home/exedev/.local/bun",
          ],
          30_000,
        );
        publicFailureMessage = "Node.js download failed";
        await remote(
          exe,
          vm.sshDest,
          [
            "curl",
            "-fsSLo",
            nodeArchive,
            `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${nodeArch}.tar.xz`,
          ],
          120_000,
        );
        publicFailureMessage = "Node.js verification failed";
        const actualChecksum = (await remote(exe, vm.sshDest, ["sha256sum", nodeArchive], 30_000))
          .trim()
          .split(/\s+/, 1)[0];
        if (actualChecksum !== checksum) throw new Error("Node.js archive checksum mismatch");
        publicFailureMessage = "Node.js installation failed";
        await remote(
          exe,
          vm.sshDest,
          ["tar", "-xJf", nodeArchive, "-C", "/home/exedev/.local/node", "--strip-components=1"],
          60_000,
        );
        publicFailureMessage = "Bun installation failed";
        await remote(
          exe,
          vm.sshDest,
          [
            "env",
            `PATH=${REMOTE_PATH}`,
            REMOTE_NPM,
            "install",
            "--global",
            "--prefix",
            "/home/exedev/.local/bun",
            `bun@${BUN_VERSION}`,
          ],
          180_000,
        );
        publicFailureMessage = "Bun verification failed";
        const bunVersion = (
          await remote(exe, vm.sshDest, [REMOTE_BUN, "--version"], 30_000)
        ).trim();
        if (bunVersion !== BUN_VERSION) throw new Error("unexpected Bun version");
        writeJson(resolve(runDir, "bootstrap.json"), {
          nodeVersion: NODE_VERSION,
          nodeArch,
          nodeSha256: checksum,
          bunVersion,
        });
        publicFailureMessage = "runtime upload failed";
        await exe.copyTo(vm.sshDest, archive.path, "/home/exedev/runtime.tar");
        await exe.copyTo(vm.sshDest, models, "/home/exedev/.pi/agent/models.json");
        await remote(
          exe,
          vm.sshDest,
          ["chmod", "600", "/home/exedev/.pi/agent/models.json"],
          30_000,
        );
        publicFailureMessage = "runtime installation failed";
        await remote(
          exe,
          vm.sshDest,
          ["tar", "-xf", "/home/exedev/runtime.tar", "-C", REMOTE_MAQUILA],
          60_000,
        );
        await remote(exe, vm.sshDest, [REMOTE_NODE, "--version"], 30_000);
        publicFailureMessage = "Maquila dependency installation failed";
        await remote(
          exe,
          vm.sshDest,
          [
            "env",
            "-C",
            REMOTE_MAQUILA,
            `PATH=${REMOTE_PATH}`,
            REMOTE_BUN,
            "install",
            "--frozen-lockfile",
            "--ignore-scripts",
          ],
          300_000,
        );
        publicFailureMessage = "Maquila build failed";
        await remote(
          exe,
          vm.sshDest,
          ["env", "-C", REMOTE_MAQUILA, `PATH=${REMOTE_PATH}`, REMOTE_BUN, "run", "build"],
          120_000,
        );
        publicFailureMessage = "target dependency installation failed";
        await remote(
          exe,
          vm.sshDest,
          [
            "env",
            "-C",
            REMOTE_WORK,
            `PATH=${REMOTE_PATH}`,
            "BUN_INSTALL=/home/exedev/.local/bun",
            REMOTE_BUN,
            "install",
            "--frozen-lockfile",
            "--ignore-scripts",
          ],
          600_000,
        );
      }
      publicFailureMessage = "OpenRouter readiness check failed";
      const modelCatalog = "/home/exedev/openrouter-models.json";
      await remote(
        exe,
        vm.sshDest,
        ["curl", "-fsS", "-o", modelCatalog, "https://openrouter.ai/api/v1/models"],
        30_000,
      );
      publicFailureMessage = "configured OpenRouter model unavailable";
      const requiredModels = [
        ...new Set(
          Object.values(archivedRoles).map((role) => role.model.slice("openrouter/".length)),
        ),
      ];
      await remote(
        exe,
        vm.sshDest,
        [
          REMOTE_NODE,
          "-e",
          "const fs=require('node:fs');const ids=new Set(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).data.map(x=>x.id));const missing=JSON.parse(process.argv[2]).filter(x=>!ids.has(x));if(missing.length){console.error(missing.join(','));process.exit(1)}",
          modelCatalog,
          JSON.stringify(requiredModels),
        ],
        30_000,
      );
      let nextPublicToolId = 1;
      let nextPublicContentId = 1;
      const remoteSequence = (expected: WorkflowStepDescriptor[], attempt = 1) => {
        let index = 0;
        let open: WorkflowStepDescriptor | undefined;
        let terminated = false;
        let negative = false;
        let pendingNegativeClosure: "failed" | "timed_out" | undefined;
        let gateSeen = false;
        let reviewSeen = false;
        let phaseContentBytes = 0;
        let incompleteContentId: string | undefined;
        const tools = new Map<string, { publicId: string; name: string }>();
        const contents = new Map<
          string,
          {
            publicId: string;
            next: number;
            count: number;
            kind?: "user_prompt" | "assistant_message" | "reasoning";
            chunks?: Array<{ text: string; sourceAt: string }>;
          }
        >();
        const allowedTools: Record<RemoteEvent["actor"], Set<string>> = {
          planner: new Set([...archivedRoles.planner.tools, "submit_envelope"]),
          worker: new Set([...archivedRoles.worker.tools, "submit_envelope"]),
          documenter: new Set([...archivedRoles.documenter.tools, "submit_envelope"]),
          verifier: new Set(),
          reviewer: new Set([...archivedRoles.reviewer.tools, "submit_envelope"]),
        };
        const contextSeen = new Set<WorkflowStepId>();
        const usageSeen = new Set<WorkflowStepId>();
        const agentStarted = new Set<WorkflowStepId>();
        const agentFinished = new Map<WorkflowStepId, "completed" | "failed" | "timed_out">();
        const closeOpen = (status: "failed" | "timed_out" = "failed"): void => {
          if (!open) return;
          emit({
            type: "phase_finished",
            actor: open.actor,
            phase: telemetryPhase(open.id, attempt),
            sourceAt: new Date().toISOString(),
            payload: { status },
          });
          tools.clear();
          open = undefined;
          negative = true;
          terminated = true;
        };
        const onEvent = (event: RemoteEvent): void => {
          if (terminated) throw new Error("remote phase sequence continued after failure");
          if (pendingNegativeClosure && event.type !== "phase_finished")
            throw new Error("remote negative result requires phase closure");
          const sourceAt = new Date(event.sourceAt).toISOString();
          const declared = workflowStep(event.stepId);
          if (event.phase !== declared.phase || event.actor !== declared.actor)
            throw new Error("invalid remote step identity");
          if (event.type === "phase_started") {
            const next = expected[index];
            if (
              open ||
              !next ||
              event.stepId !== next.id ||
              event.phase !== next.phase ||
              event.actor !== next.actor
            )
              throw new Error("invalid remote phase sequence");
            open = next;
            phaseContentBytes = 0;
            incompleteContentId = undefined;
            contents.clear();
            advance(runDir, event.phase, event.actor, sourceAt, attempt, event.stepId);
            if (event.actor !== "verifier") {
              const role = archivedRoles[event.actor];
              emit({
                type: "agent_context",
                actor: event.actor,
                phase: telemetryPhase(event.stepId, attempt),
                payload: {
                  model: role.model,
                  description: role.description,
                  tools: [...role.tools, "submit_envelope"],
                  thinking: role.thinking,
                  access: role.access,
                  systemPromptSha256: createHash("sha256").update(role.systemPrompt).digest("hex"),
                },
              });
              contextSeen.add(event.stepId);
            }
            return;
          }
          if (
            !open ||
            event.stepId !== open.id ||
            event.phase !== open.phase ||
            event.actor !== open.actor
          )
            throw new Error("remote event outside active phase");
          if (
            incompleteContentId &&
            (event.type !== "agent_content" || event.contentId !== incompleteContentId)
          )
            throw new Error("remote event interleaved with incomplete agent content");
          if (
            usageSeen.has(event.stepId) &&
            [
              "agent_started",
              "agent_finished",
              "tool_started",
              "tool_finished",
              "agent_content",
              "agent_content_unavailable",
            ].includes(event.type)
          )
            throw new Error("remote agent activity after usage");
          const phase = telemetryPhase(event.stepId, attempt);
          switch (event.type) {
            case "phase_finished":
              if (tools.size) throw new Error("remote phase finished with active tool calls");
              if ([...contents.values()].some((content) => content.count > content.next))
                throw new Error("remote phase finished with incomplete agent content");
              if (
                event.actor !== "verifier" &&
                event.status === "completed" &&
                (agentFinished.get(event.stepId) !== "completed" || !usageSeen.has(event.stepId))
              )
                throw new Error("completed remote agent phase lacks completed agent usage");
              if (pendingNegativeClosure && event.status !== pendingNegativeClosure)
                throw new Error("remote phase closure contradicts negative result");
              emit({
                type: "phase_finished",
                actor: event.actor,
                phase,
                sourceAt,
                payload: { status: event.status },
              });
              if (event.status !== "completed") {
                negative = true;
                terminated = true;
              }
              pendingNegativeClosure = undefined;
              open = undefined;
              index += 1;
              break;
            case "agent_started":
              if (agentStarted.has(event.stepId) || agentFinished.has(event.stepId))
                throw new Error("invalid remote agent lifecycle");
              agentStarted.add(event.stepId);
              emit({ type: "agent_started", actor: event.actor, phase, sourceAt, payload: {} });
              break;
            case "agent_finished":
              if (!agentStarted.has(event.stepId) || agentFinished.has(event.stepId) || tools.size)
                throw new Error("invalid remote agent lifecycle");
              agentFinished.set(event.stepId, event.status);
              emit({
                type: "agent_finished",
                actor: event.actor,
                phase,
                sourceAt,
                payload: { status: event.status },
              });
              break;
            case "agent_usage":
              if (
                !contextSeen.has(event.stepId) ||
                agentFinished.get(event.stepId) !== "completed" ||
                tools.size ||
                usageSeen.has(event.stepId)
              )
                throw new Error("invalid remote agent usage");
              usageSeen.add(event.stepId);
              emit({
                type: "agent_usage",
                actor: event.actor,
                phase,
                sourceAt,
                payload: {
                  ...event.tokens,
                  ...(event.contextTokens === undefined
                    ? {}
                    : {
                        contextTokens: event.contextTokens,
                        contextWindow: event.contextWindow!,
                      }),
                  ...(event.reportedCostNanoUsd === undefined
                    ? {}
                    : { reportedCostNanoUsd: event.reportedCostNanoUsd }),
                },
              });
              break;
            case "agent_content": {
              if (!agentStarted.has(event.stepId) || agentFinished.has(event.stepId))
                throw new Error("invalid remote agent content");
              phaseContentBytes += Buffer.byteLength(event.text);
              if (phaseContentBytes > 512 * 1024)
                throw new Error("remote agent content exceeds phase limit");
              let content = contents.get(event.contentId);
              if (!content) {
                if (event.chunkIndex !== 0)
                  throw new Error("invalid remote content chunk sequence");
                content = {
                  publicId: `content-${nextPublicContentId++}`,
                  next: 0,
                  count: event.chunkCount,
                  kind: event.kind,
                  chunks: [],
                };
                contents.set(event.contentId, content);
                incompleteContentId = event.contentId;
              }
              if (
                content.next !== event.chunkIndex ||
                content.count !== event.chunkCount ||
                content.kind !== event.kind ||
                !content.chunks
              )
                throw new Error("invalid remote content chunk sequence");
              content.next += 1;
              content.chunks.push({ text: event.text, sourceAt });
              if (content.next === content.count) {
                incompleteContentId = undefined;
                assertSecretAbsent(
                  Buffer.from(content.chunks.map((chunk) => chunk.text).join("")),
                  [options.openRouterKey, options.linearToken, options.githubToken],
                );
                for (const [chunkIndex, chunk] of content.chunks.entries())
                  emit({
                    type: "agent_content",
                    actor: event.actor,
                    phase,
                    sourceAt: chunk.sourceAt,
                    payload: {
                      contentId: content.publicId,
                      kind: event.kind,
                      chunkIndex,
                      chunkCount: content.count,
                      text: chunk.text,
                    },
                  });
              }
              break;
            }
            case "agent_content_unavailable": {
              if (
                !agentStarted.has(event.stepId) ||
                agentFinished.has(event.stepId) ||
                contents.has(event.contentId)
              )
                throw new Error("invalid remote agent content");
              const publicId = `content-${nextPublicContentId++}`;
              contents.set(event.contentId, { publicId, next: 0, count: 0 });
              emit({
                type: "agent_content_unavailable",
                actor: event.actor,
                phase,
                sourceAt,
                payload: { contentId: publicId, kind: event.kind, reason: event.reason },
              });
              break;
            }
            case "tool_started": {
              if (
                !agentStarted.has(event.stepId) ||
                agentFinished.has(event.stepId) ||
                !allowedTools[event.actor].has(event.toolName) ||
                tools.has(event.toolCallId)
              )
                throw new Error("invalid remote tool activity");
              const publicId = `tool-${nextPublicToolId}`;
              nextPublicToolId += 1;
              tools.set(event.toolCallId, { publicId, name: event.toolName });
              emit({
                type: "tool_started",
                actor: event.actor,
                phase,
                sourceAt,
                payload: { toolName: event.toolName, toolCallId: publicId },
              });
              break;
            }
            case "tool_finished": {
              const tool = tools.get(event.toolCallId);
              if (
                !agentStarted.has(event.stepId) ||
                agentFinished.has(event.stepId) ||
                !tool ||
                tool.name !== event.toolName
              )
                throw new Error("invalid remote tool activity");
              tools.delete(event.toolCallId);
              emit({
                type: "tool_finished",
                actor: event.actor,
                phase,
                sourceAt,
                payload: {
                  toolName: event.toolName,
                  toolCallId: tool.publicId,
                  isError: event.isError,
                },
              });
              break;
            }
            case "gate_finished":
              if (gateSeen) throw new Error("duplicate remote gate result");
              gateSeen = true;
              emit({
                type: "gate_finished",
                actor: "verifier",
                phase,
                sourceAt,
                payload: {
                  passed: event.passed,
                  commandCount: event.commandCount,
                  changedPathCount: event.changedPathCount,
                  timedOut: event.timedOut,
                },
              });
              if (!event.passed) {
                negative = true;
                pendingNegativeClosure = event.timedOut ? "timed_out" : "failed";
              }
              break;
            case "review_finished":
              if (reviewSeen) throw new Error("duplicate remote review result");
              reviewSeen = true;
              emit({
                type: "review_finished",
                actor: "reviewer",
                phase,
                sourceAt,
                payload: { verdict: event.verdict, blockerCount: event.blockerCount },
              });
              if (event.verdict !== "PASS" || event.blockerCount > 0) {
                negative = true;
                pendingNegativeClosure = "failed";
              }
              break;
          }
        };
        return {
          onEvent,
          closeOpen,
          finish(result: RemoteResultFrame) {
            if (open || pendingNegativeClosure) throw new Error("remote phase did not finish");
            if (negative && result.status === "completed")
              throw new Error("remote completed result contradicts negative phase evidence");
            if (terminated && !["failed", "timed_out"].includes(result.status))
              throw new Error("remote terminal result contradicts failed phase");
            if (
              result.status === "completed" &&
              (index !== expected.length ||
                negative ||
                terminated ||
                (expected.some((step) => step.id === "verify") && !gateSeen) ||
                (expected.some((step) => step.id === "review") && !reviewSeen))
            )
              throw new Error("remote completed result contradicts phase evidence");
          },
        };
      };
      const issue = "/home/exedev/issue.md";
      const localIssue = resolve(runDir, "issue.md");
      const checkpoint = resolve(runDir, "planner-session.jsonl");
      const remoteCheckpoint = "/home/exedev/planner-session.jsonl";
      await exe.copyTo(vm.sshDest, localIssue, issue);
      let plannerAttempt = initialPlannerAttempt;
      let resumeSession = initialResumeSession;
      if (resumeSession) {
        if (hash(checkpoint) !== resumeSession.sha256)
          throw new Error("planner session checkpoint changed");
        await exe.copyTo(vm.sshDest, checkpoint, remoteCheckpoint);
        await remote(exe, vm.sshDest, ["chmod", "600", remoteCheckpoint], 30_000);
      }
      let plannerRun = "";
      let parsedPlan: EnvelopeParseResult<PlannerEnvelope> | undefined;
      for (;;) {
        const plannerSequence = remoteSequence([workflowStep("plan")], plannerAttempt);
        let plannerResult: RemoteResultFrame;
        const plannerArgv = [
          "env",
          "-C",
          REMOTE_MAQUILA,
          `PATH=${REMOTE_PATH}`,
          `${REMOTE_MAQUILA}/dist/maquila`,
          "pi",
          "plan",
          "--repo",
          REMOTE_WORK,
          "--issue",
          issue,
          "--timeout-seconds",
          String(options.timeoutSeconds),
          "--machine",
          ...(resumeSession
            ? [
                "--resume-session",
                remoteCheckpoint,
                "--session-id",
                resumeSession.sessionId,
                "--session-sha256",
                resumeSession.sha256,
              ]
            : []),
        ];
        try {
          plannerResult = await streamed(
            exe,
            vm.sshDest,
            plannerArgv,
            options.timeoutSeconds * 1000 + 60_000,
            plannerSequence.onEvent,
          );
          plannerSequence.finish(plannerResult);
        } catch (error) {
          plannerSequence.closeOpen();
          throw error;
        }
        stage = "planning_result";
        publicFailureMessage = "planner result is invalid";
        plannerRun = outputPath(plannerResult.runDir, "Run evidence");
        if (plannerResult.status !== "completed") {
          if (plannerResult.failure)
            publicFailureMessage = remoteFailureMessage(plannerResult.failure);
          throw new Error("remote planner failed");
        }
        publicFailureMessage = "planner envelope retrieval failed";
        const plannerEnvelope = JSON.parse(
          await remote(exe, vm.sshDest, ["cat", `${plannerRun}/envelope.json`], 30_000),
        ) as unknown;
        stage = "planning_envelope";
        publicFailureMessage = "planner envelope validation failed";
        parsedPlan = parseEnvelope("planner", plannerEnvelope);
        if (!parsedPlan.ok) throw new Error("remote planner envelope is invalid");
        if (!parsedPlan.envelope.decisionsNeeded.length) break;
        if (!intakeSnapshot) throw new Error("planner intake snapshot missing");
        if (plannerAttempt > 3) throw new Error("planner decision round limit exceeded");
        const plannerReceipt = JSON.parse(
          await remote(exe, vm.sshDest, ["cat", `${plannerRun}/receipt.json`], 30_000),
        ) as unknown;
        if (
          !isRecord(plannerReceipt) ||
          typeof plannerReceipt.sessionId !== "string" ||
          typeof plannerReceipt.sessionFile !== "string" ||
          plannerReceipt.sessionFile !==
            `${plannerRun}/sessions/${basename(plannerReceipt.sessionFile)}` ||
          !plannerReceipt.sessionFile.endsWith(".jsonl")
        )
          throw new Error("planner session checkpoint missing");
        await exe.copyFrom(vm.sshDest, plannerReceipt.sessionFile, checkpoint);
        chmodSync(checkpoint, 0o600);
        if (statSync(checkpoint).size > MAX_SESSION_CHECKPOINT) {
          rmSync(checkpoint, { force: true });
          throw new Error("planner session checkpoint exceeds limit");
        }
        assertSecretAbsent(readFileSync(checkpoint), [options.openRouterKey]);
        const checkpointSha256 = hash(checkpoint);
        await remote(exe, vm.sshDest, ["rm", "-f", "/home/exedev/.pi/agent/models.json"], 30_000);
        stage = "planning_decision_comment";
        publicFailureMessage = "Linear decision comment creation failed";
        const comment = await (options.createDecisionComment ?? createLinearDecisionComment)({
          token: options.linearToken,
          issueId: intakeSnapshot.issue.uuid,
          assigneeUrl: intakeSnapshot.issue.assignee.url,
          assigneeId: intakeSnapshot.issue.assignee.id,
          runId: state.runId,
          generation: plannerAttempt,
          decisions: parsedPlan.envelope.decisionsNeeded,
        });
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        state = beginControllerDecisionWait(runDir, {
          generation: plannerAttempt,
          expiresAt,
          plannerRunId: basename(plannerRun),
          plannerSessionId: plannerReceipt.sessionId,
          plannerSessionSha256: checkpointSha256,
          checkpointSha256,
        });
        decisionRequest = {
          runId: state.runId,
          ...comment,
          continuationRunId: state.runId,
          issue: options.issue,
          owner: options.owner,
          repo: options.repo,
          baseRef: options.baseRef,
          tag: options.tag,
          timeoutSeconds: options.timeoutSeconds,
        };
        writeJson(resolve(runDir, "decision-request.json"), {
          version: 1,
          ...decisionRequest,
          generation: plannerAttempt,
          expiresAt,
          assigneeId: intakeSnapshot.issue.assignee.id,
          count: parsedPlan.envelope.decisionsNeeded.length,
          decisions: parsedPlan.envelope.decisionsNeeded,
        });
        emit({
          type: "decision_requested",
          actor: "controller",
          payload: {
            count: parsedPlan.envelope.decisionsNeeded.length,
            commentId: comment.commentId,
            commentUrl: comment.commentUrl,
            continuationRunId: state.runId,
          },
        });
        if (!options.inlineDecisionWaiter) throw new PlannerDecisionRequired(decisionRequest);
        emit({
          type: "phase_started",
          actor: "controller",
          phase: {
            id: `awaiting_decision:${plannerAttempt}`,
            name: "awaiting_decision",
            attempt: plannerAttempt,
          },
          payload: {},
        });
        const waitingState = state;
        let releaseResumeLease: () => void;
        try {
          releaseResumeLease = acquireDecisionResumeLease(runDir);
        } catch {
          throw new PlannerDecisionRequired(decisionRequest);
        }
        lock.release();
        let decision: LinearDecisionReply;
        try {
          decision = await options.inlineDecisionWaiter(decisionRequest, expiresAt);
        } catch (error) {
          releaseResumeLease();
          lock = acquireControllerLock(root);
          state = transitionControllerState(
            runDir,
            Date.now() >= Date.parse(expiresAt) ? "cancelled" : "failed",
          );
          throw error;
        }
        lock = acquireControllerLock(root);
        releaseResumeLease();
        const current = readControllerState(runDir);
        if (
          current.updatedAt !== waitingState.updatedAt ||
          current.state !== "awaiting_decision" ||
          current.decisionWait?.generation !== plannerAttempt
        )
          throw new Error("decision wait changed while accepting reply");
        if (
          Date.now() >= Date.parse(expiresAt) ||
          Date.parse(decision.createdAt) > Date.parse(expiresAt)
        ) {
          state = transitionControllerState(runDir, "cancelled");
          throw new Error("decision wait expired");
        }
        try {
          await remote(exe, current.vm!.sshDest, ["true"], 30_000);
        } catch {
          throw new PlannerDecisionRequired(decisionRequest);
        }
        const refreshed = await (options.intake ?? createIntake)(
          { token: options.linearToken, issue: options.issue },
          {
            token: options.githubToken,
            owner: options.owner,
            repo: options.repo,
            baseRef: options.baseRef,
          },
        );
        if (
          refreshed.issue.snapshotSha256 !== state.issueSnapshotSha256 ||
          refreshed.repository.snapshotSha256 !== state.repositorySnapshotSha256 ||
          refreshed.repository.baseSha !== state.baseSha
        ) {
          state = transitionControllerState(runDir, "failed");
          throw new Error("decision wait input drifted");
        }
        writeJson(resolve(runDir, "decision-accepted.json"), {
          version: 1,
          generation: plannerAttempt,
          requestCommentId: comment.commentId,
          decision,
        });
        state = transitionControllerState(
          runDir,
          isControllerStateV2(state) ? "executing" : "planning",
        );
        writeFileSync(
          localIssue,
          `${readFileSync(localIssue, "utf8").trimEnd()}\n\n## Engineer decision ${plannerAttempt}\n\n${decision.body}\n`,
          { mode: 0o600 },
        );
        await exe.copyTo(vm.sshDest, localIssue, issue);
        if (
          (
            await remote(exe, vm.sshDest, ["git", "-C", REMOTE_WORK, "rev-parse", "HEAD"], 30_000)
          ).trim() !== state.baseSha ||
          (
            await remote(
              exe,
              vm.sshDest,
              ["git", "-C", REMOTE_WORK, "status", "--porcelain"],
              30_000,
            )
          ).trim()
        )
          throw new Error("retained decision workspace changed");
        await remote(exe, vm.sshDest, ["test", "-x", `${REMOTE_MAQUILA}/dist/maquila`], 30_000);
        await exe.copyTo(vm.sshDest, models, "/home/exedev/.pi/agent/models.json");
        await remote(
          exe,
          vm.sshDest,
          ["chmod", "600", "/home/exedev/.pi/agent/models.json"],
          30_000,
        );
        if (hash(checkpoint) !== checkpointSha256) {
          state = transitionControllerState(runDir, "failed");
          throw new Error("planner session checkpoint changed");
        }
        await exe.copyTo(vm.sshDest, checkpoint, remoteCheckpoint);
        await remote(exe, vm.sshDest, ["chmod", "600", remoteCheckpoint], 30_000);
        emit({
          type: "phase_finished",
          actor: "controller",
          phase: {
            id: `awaiting_decision:${plannerAttempt}`,
            name: "awaiting_decision",
            attempt: plannerAttempt,
          },
          payload: { status: "completed" },
        });
        resumeSession = { sessionId: plannerReceipt.sessionId, sha256: checkpointSha256 };
        plannerAttempt += 1;
        decisionRequest = undefined;
      }
      if (!parsedPlan?.ok) throw new Error("remote planner envelope is invalid");
      publicFailureMessage = "workflow manifest generation failed";
      const workflowManifest = createFeaturePrManifest({
        plannerRunId: basename(plannerRun),
        baseSha: state.baseSha,
        plan: parsedPlan.envelope,
      });
      const hasWorker = workflowManifest.steps.some(
        (step) => step.id === "implement" && step.status === "pending",
      );
      const localManifest = resolve(runDir, "workflow-manifest.json");
      writeJson(localManifest, workflowManifest);
      if (isControllerStateV2(state))
        state = pinControllerWorkflowManifest(runDir, hash(localManifest));
      const remoteManifest = "/home/exedev/workflow-manifest.json";
      await exe.copyTo(vm.sshDest, localManifest, remoteManifest);
      const workerSequence = remoteSequence(
        featurePrRemoteStepsFromManifest(workflowManifest.steps),
      );
      let workerResult: RemoteResultFrame;
      try {
        workerResult = await streamed(
          exe,
          vm.sshDest,
          [
            "env",
            "-C",
            REMOTE_MAQUILA,
            `PATH=${REMOTE_PATH}`,
            `${REMOTE_MAQUILA}/dist/maquila`,
            "pi",
            "worker",
            "--repo",
            REMOTE_WORK,
            "--issue",
            issue,
            "--planner",
            `${plannerRun}/envelope.json`,
            "--base-sha",
            state.baseSha,
            "--timeout-seconds",
            String(options.timeoutSeconds),
            "--workflow-manifest",
            remoteManifest,
            "--machine",
          ],
          options.timeoutSeconds * 3000 + 120_000,
          workerSequence.onEvent,
        );
        workerSequence.finish(workerResult);
      } catch (error) {
        workerSequence.closeOpen();
        throw error;
      }
      const workerRun = outputPath(workerResult.runDir, "Run evidence");
      if (workerResult.status !== "completed") {
        try {
          await remote(exe, vm.sshDest, ["cat", `${workerRun}/lifecycle.json`], 30_000);
        } catch {
          // Failure evidence stays in the remote run directory for harvest/debug copies.
        }
        if (workerResult.failure) publicFailureMessage = remoteFailureMessage(workerResult.failure);
        throw new Error("remote worker lifecycle failed");
      }
      publicFailureMessage = "workflow execution retrieval failed";
      const remoteExecution = parseWorkflowExecution(
        JSON.parse(
          await remote(exe, vm.sshDest, ["cat", `${workerRun}/workflow-execution.json`], 30_000),
        ) as unknown,
      );
      stage = "harvesting";
      const patch = await remote(
        exe,
        vm.sshDest,
        ["git", "-C", REMOTE_WORK, "add", "-A"],
        30_000,
      ).then(() =>
        remote(
          exe,
          vm.sshDest,
          ["git", "-C", REMOTE_WORK, "diff", "--cached", "--binary", "--no-ext-diff", "HEAD"],
          60_000,
        ),
      );
      if (!patch || Buffer.byteLength(patch) > MAX_PATCH)
        throw new Error("change patch missing or exceeds limit");
      assertSecretAbsent(patch, [options.openRouterKey]);
      writeFileSync(resolve(runDir, "change.patch"), patch, { mode: 0o600 });
      const patchSha256 = createHash("sha256").update(patch).digest("hex");
      reviewedPatchSha256 = patchSha256;
      emit({
        type: "artifact_available",
        actor: "controller",
        payload: { name: "change.patch", size: Buffer.byteLength(patch), sha256: patchSha256 },
      });
      publicFailureMessage = "workflow execution validation failed";
      assertFeaturePrExecution(remoteExecution, workflowManifest, patchSha256);
      const reviewerRun = outputPath(workerResult.reviewerRunDir, "Reviewer evidence");
      if (completedStepRunId(remoteExecution, "review") !== basename(reviewerRun))
        throw new Error("workflow execution reviewer run mismatch");
      const documenterRun = outputPath(
        `${REMOTE_RUN}${completedStepRunId(remoteExecution, "document")}`,
        "Documenter evidence",
      );
      const runIds = [basename(plannerRun), ...completedExecutionRunIds(remoteExecution)];
      await remote(
        exe,
        vm.sshDest,
        [
          "tar",
          "-cf",
          "/home/exedev/evidence.tar",
          "-C",
          REMOTE_MAQUILA,
          ...runIds.map((id) => `.maquila/runs/${id}`),
        ],
        60_000,
      );
      await exe.copyFrom(vm.sshDest, "/home/exedev/evidence.tar", resolve(runDir, "evidence.tar"));
      chmodSync(resolve(runDir, "evidence.tar"), 0o600);
      assertArtifactSafe(
        resolve(runDir, "evidence.tar"),
        [options.openRouterKey],
        "evidence archive",
      );
      harvest(resolve(runDir, "evidence.tar"), runDir, {
        manifest: workflowManifest,
        execution: remoteExecution,
      });
      emit({
        type: "artifact_available",
        actor: "controller",
        payload: {
          name: "evidence.tar",
          size: statSync(resolve(runDir, "evidence.tar")).size,
          sha256: hash(resolve(runDir, "evidence.tar")),
        },
      });
      writeJson(resolve(runDir, "remote-runs.json"), {
        plannerRun,
        ...(hasWorker ? { workerRun } : {}),
        documenterRun,
        reviewerRun,
      });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (error instanceof PlannerDecisionRequired) {
      decisionRequest = error.request;
    } else {
      try {
        closeHostPhase("failed");
      } catch {
        telemetryBroken = true;
      }
      if (!state && evidenceDir !== provisional && existsSync(evidenceDir)) {
        renameSync(evidenceDir, provisional);
        evidenceDir = provisional;
      }
      failure = sanitizeTelemetryText(error instanceof Error ? error.message : String(error), [
        options.linearToken,
        options.githubToken,
        options.openRouterKey,
      ]);
      const detail = publicFailureDetail(error);
      bestEffortEmit({
        type: "failure",
        actor: "controller",
        payload: {
          stage,
          message: sanitizeTelemetryText(
            detail ? `${publicFailureMessage} (${detail})` : publicFailureMessage,
            [options.linearToken, options.githubToken, options.openRouterKey],
          ),
        },
      });
    }
  }
  if (failure && state?.state === "awaiting_decision" && state.decisionWait) {
    state = transitionControllerState(
      resolve(root, ".maquila", "controllers", state.runId),
      "failed",
    );
  }
  if (failure && state?.vm) {
    const runDir = resolve(root, ".maquila", "controllers", state.runId);
    const target = resolve(runDir, "failure-evidence.tar");
    try {
      await remote(
        exe,
        state.vm.sshDest,
        ["tar", "-cf", "/home/exedev/evidence.tar", "-C", REMOTE_MAQUILA, ".maquila/runs"],
        60_000,
      );
      await exe.copyFrom(state.vm.sshDest, "/home/exedev/evidence.tar", target);
      chmodSync(target, 0o600);
      assertArtifactSafe(target, [options.openRouterKey], "failure evidence archive");
      bestEffortEmit({
        type: "artifact_available",
        actor: "controller",
        payload: {
          name: "failure-evidence.tar",
          size: statSync(target).size,
          sha256: hash(target),
        },
      });
    } catch {
      bestEffortEmit({
        type: "failure",
        actor: "controller",
        payload: { stage: "failure_evidence", message: "failure evidence unavailable" },
      });
    }
  }
  try {
    const cleanupRequired =
      state !== undefined &&
      state.state !== "intake" &&
      !(!failure && decisionRequest && state.state === "awaiting_decision" && state.decisionWait);
    if (state && cleanupRequired) {
      if (state.vm) {
        try {
          await remote(
            exe,
            state.vm.sshDest,
            ["rm", "-f", "/home/exedev/.pi/agent/models.json"],
            30_000,
          );
        } catch {}
      }
      const cleaned = await exe.destroyVm(state.vm?.name ?? vmName(state.runId));
      if (!cleaned.destroyed && !cleaned.notFound) throw new Error("VM cleanup failed");
      cleanupOutcome = "complete";
      state = recordControllerCleanup(
        resolve(root, ".maquila", "controllers", state.runId),
        "complete",
      );
      try {
        emit({
          type: "cleanup_updated",
          actor: "controller",
          payload: { cleanup: "complete" },
        });
      } catch (error) {
        failure ??= error instanceof Error ? error.message : String(error);
      }
    }
  } catch (error) {
    cleanupFailed = true;
    cleanupOutcome = "failed";
    if (!failure) stage = "cleanup";
    if (state?.vm) {
      try {
        state = recordControllerCleanup(
          resolve(root, ".maquila", "controllers", state.runId),
          "failed",
        );
        bestEffortEmit({
          type: "cleanup_updated",
          actor: "controller",
          payload: { cleanup: "failed" },
        });
      } catch {}
    }
    const cleanupError = error instanceof Error ? error.message : String(error);
    failure = `${failure ?? cleanupError}; revoke the dedicated OpenRouter key`;
  }
  try {
    archive?.cleanup();
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error);
  }

  let result: ControllerResult;
  try {
    const runDir = state ? resolve(root, ".maquila", "controllers", state.runId) : evidenceDir;
    const failedResult = (message: string): ControllerResult => {
      stopHeartbeat();
      try {
        closeHostPhase("failed");
      } catch {
        telemetryBroken = true;
      }
      const error = sanitizeTelemetryText(message, [
        options.linearToken,
        options.githubToken,
        options.openRouterKey,
      ]);
      if (state && !cleanupFailed && state.state !== "failed" && state.state !== "cancelled") {
        state = transitionControllerState(runDir, "failed");
        bestEffortEmit({
          type: "phase_started",
          actor: "controller",
          phase: { id: "failed:1", name: "failed", attempt: 1 },
          payload: {},
        });
      }
      writeJson(resolve(runDir, "receipt.json"), {
        kind: "controller",
        status: "failed",
        stage,
        startedAt,
        finishedAt: new Date().toISOString(),
        cleanup: cleanupOutcome,
        artifacts: readdirArtifacts(runDir),
        error,
      });
      bestEffortEmit({
        type: "run_finished",
        actor: "controller",
        payload: {
          status: "failed",
          cleanup: cleanupOutcome,
        },
      });
      return { status: "failed", runDir, error };
    };

    const cancelledResult = (message: string): ControllerResult => {
      stopHeartbeat();
      const error = sanitizeTelemetryText(message, [
        options.linearToken,
        options.githubToken,
        options.openRouterKey,
      ]);
      writeJson(resolve(runDir, "receipt.json"), {
        kind: "controller",
        status: "cancelled",
        stage: "decision_expired",
        startedAt,
        finishedAt: new Date().toISOString(),
        cleanup: cleanupOutcome,
        artifacts: readdirArtifacts(runDir),
        error,
      });
      bestEffortEmit({
        type: "run_finished",
        actor: "controller",
        payload: { status: "cancelled", cleanup: cleanupOutcome },
      });
      return { status: "cancelled", runDir, error };
    };

    if (state?.state === "cancelled") {
      result = cancelledResult(failure ?? "decision wait expired");
    } else if (!state || failure) {
      result = failedResult(failure ?? "intake failed");
    } else if (decisionRequest) {
      const decisionGeneration = decisionRequest.generation;
      if (decisionGeneration === undefined) throw new Error("decision generation missing");
      if (state.state !== "awaiting_decision")
        state = transitionControllerState(runDir, "awaiting_decision");
      bestEffortEmit({
        type: "phase_started",
        actor: "controller",
        phase: {
          id: `awaiting_decision:${decisionGeneration}`,
          name: "awaiting_decision",
          attempt: decisionGeneration,
        },
        payload: {},
      });
      stopHeartbeat();
      writeJson(resolve(runDir, "receipt.json"), {
        kind: "controller",
        status: "awaiting_decision",
        stage: "planning_decision",
        startedAt,
        finishedAt: new Date().toISOString(),
        cleanup: cleanupOutcome,
        artifacts: readdirArtifacts(runDir),
        decisionRequest,
      });
      bestEffortEmit({
        type: "run_finished",
        actor: "controller",
        payload: { status: "awaiting_decision", cleanup: cleanupOutcome },
      });
      result = { status: "awaiting_decision", runDir, decisionRequest };
    } else {
      try {
        if (!intakeSnapshot || !reviewedPatchSha256)
          throw new Error("publication evidence is incomplete");
        closeHostPhase();
        state = isControllerStateV2(state)
          ? completeControllerWorkflow(runDir, hash(resolve(runDir, "workflow-manifest.json")))
          : transitionControllerState(runDir, "ready_for_publication");
        emit({
          type: "phase_started",
          actor: "controller",
          phase: { id: "ready_for_publication:1", name: "ready_for_publication", attempt: 1 },
          payload: {},
        });
        openHostPhase = "ready_for_publication";
        stage = "ready_for_publication";
        publicFailureMessage = "controller stage failed";
        advance(runDir, "publishing");
        const publicationInput: GitHubPublicationOptions = {
          token: options.githubToken,
          owner: options.owner,
          repo: options.repo,
          baseRef: state.baseRef,
          baseSha: state.baseSha,
          runId: state.runId,
          idempotencyKey: state.idempotencyKey,
          issueIdentifier: intakeSnapshot.issue.identifier,
          issueTitle: intakeSnapshot.issue.title,
          issueUrl: intakeSnapshot.issue.url,
          patchPath: resolve(runDir, "change.patch"),
          patchSha256: reviewedPatchSha256,
        };
        let pullRequest: GitHubPublication | undefined;
        let publicationDryRun: GitHubPublicationDryRun | undefined;
        if (options.publicationMode === "dry-run") {
          publicationDryRun = createGitHubPublicationDryRun(publicationInput);
          const publicationPath = resolve(runDir, "publication-dry-run.json");
          writeJson(publicationPath, publicationDryRun);
          emit({
            type: "artifact_available",
            actor: "controller",
            payload: {
              name: "publication-dry-run.json",
              size: statSync(publicationPath).size,
              sha256: hash(publicationPath),
            },
          });
        } else {
          pullRequest = await (options.publish ?? publishGitHubPullRequest)(publicationInput);
          const publicationPath = resolve(runDir, "publication.json");
          writeJson(publicationPath, pullRequest);
          emit({
            type: "artifact_available",
            actor: "controller",
            payload: {
              name: "publication.json",
              size: statSync(publicationPath).size,
              sha256: hash(publicationPath),
            },
          });
          emit({
            type: "publication_completed",
            actor: "controller",
            payload: pullRequest,
          });
        }
        advance(runDir, "completed");
        stopHeartbeat();
        writeJson(resolve(runDir, "receipt.json"), {
          kind: "controller",
          status: "completed",
          stage: "completed",
          startedAt,
          finishedAt: new Date().toISOString(),
          cleanup: "complete",
          artifacts: readdirArtifacts(runDir),
          ...(pullRequest ? { pullRequest } : { publicationDryRun }),
        });
        emit({
          type: "run_finished",
          actor: "controller",
          payload: { status: "completed", cleanup: "complete" },
        });
        result = {
          status: "completed",
          runDir,
          ...(pullRequest ? { pullRequest } : { publicationDryRun }),
        };
      } catch (error) {
        result = failedResult(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    stopHeartbeat();
    lock.release();
  }
  return result;
}
