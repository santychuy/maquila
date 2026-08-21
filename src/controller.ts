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
import { createIntake } from "./intake.js";
import { publishGitHubPullRequest, type GitHubPublication } from "./github.js";
import { parseEnvelope } from "./envelope.js";
import { assertSafeRepoPath } from "./verify.js";
import { ExeClient } from "./exe.js";
import {
  createControllerState,
  recordControllerCleanup,
  recordControllerVm,
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
  type RemoteResultFrame,
} from "./remote-protocol.js";
import {
  createTelemetryWriter,
  readTelemetry,
  sanitizeTelemetryText,
  telemetryPath,
  type TelemetryInput,
  type TelemetryWriter,
} from "./telemetry.js";

const REMOTE_FACTORY = "/home/exedev/factory";
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
const REMOTE_RUN = `${REMOTE_FACTORY}/.factory/runs/`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type RemotePhase = RemoteEvent["phase"];
type RemoteActor = RemoteEvent["actor"];
const PHASE_OWNER: Record<RemotePhase, RemoteActor> = {
  planning: "planner",
  implementing: "worker",
  documenting: "documenter",
  verifying: "verifier",
  reviewing: "reviewer",
};
function telemetryPhase(phase: RemotePhase): { id: string; name: RemotePhase; attempt: 1 } {
  return { id: `${phase}:1`, name: phase, attempt: 1 };
}

function claimedPaths(paths: string[]): string[] | undefined {
  try {
    const safe = paths.map(assertSafeRepoPath);
    return new Set(safe).size === safe.length ? safe.toSorted() : undefined;
  } catch {
    return undefined;
  }
}

function isDocs(path: string): boolean {
  return path === "docs" || path.startsWith("docs/");
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
  factoryRoot?: string;
  exe?: ControllerExe;
  intake?: typeof createIntake;
  sleep?: (milliseconds: number) => Promise<void>;
  runId?: string;
  telemetry?: typeof createTelemetryWriter;
  publish?: typeof publishGitHubPullRequest;
  onAccepted?: () => void;
  heartbeatMilliseconds?: number;
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
  status: "completed" | "failed";
  runDir: string;
  pullRequest?: GitHubPublication;
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
  return `factory-${runId.replaceAll("-", "").slice(0, 24)}`;
}
function outputPath(path: string | undefined, label: string): string {
  if (!path?.startsWith(REMOTE_RUN) || !UUID.test(path.slice(REMOTE_RUN.length))) {
    throw new Error(`remote ${label.toLowerCase()} missing`);
  }
  return path;
}
function json(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
function privatizeTree(path: string): void {
  const metadata = statSync(path);
  chmodSync(path, metadata.isDirectory() ? 0o700 : 0o600);
  if (metadata.isDirectory())
    for (const name of readdirSync(path)) privatizeTree(resolve(path, name));
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
export interface HarvestExpectations {
  baseSha: string;
  allowedPaths: string[];
  patchSha256: string;
}

export function harvest(
  archive: string,
  runDir: string,
  runs: string[],
  expected: HarvestExpectations,
): void {
  const names = execFileSync("tar", ["-tf", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  if (
    !names.length ||
    names.some(
      (name) => !name.startsWith(".factory/runs/") || name.includes("..") || name.startsWith("/"),
    )
  )
    throw new Error("unsafe evidence archive path");
  const verbose = execFileSync("tar", ["-tvf", archive], { encoding: "utf8" });
  if (verbose.split("\n").some((line) => /^[lhbcps]/.test(line)))
    throw new Error("unsafe evidence archive member");
  const target = resolve(runDir, "remote-evidence");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  execFileSync("tar", ["-xf", archive, "-C", target]);
  privatizeTree(target);
  for (const run of runs) {
    if (!UUID.test(run)) throw new Error("unsafe remote run id");
  }
  if (new Set(runs).size !== runs.length) throw new Error("remote run ids must be distinct");
  const docsOnly = expected.allowedPaths.every((path) => {
    const safe = assertSafeRepoPath(path);
    return safe === "docs" || safe.startsWith("docs/");
  });
  if (runs.length !== (docsOnly ? 3 : 4)) throw new Error("remote lifecycle run count is invalid");
  const plannerRun = runs[0]!;
  const workerRun = docsOnly ? undefined : runs[1]!;
  const documenterRun = runs[docsOnly ? 1 : 2]!;
  const reviewerRun = runs[docsOnly ? 2 : 3]!;
  const primaryRun = workerRun ?? documenterRun;
  const required = [
    [plannerRun, "receipt.json"],
    [plannerRun, "envelope.json"],
    [plannerRun, "plan.md"],
    [primaryRun, "receipt.json"],
    [primaryRun, "lifecycle.json"],
    [primaryRun, "verification.json"],
    [primaryRun, "review-diff.sha256"],
    [documenterRun, "envelope.json"],
    [reviewerRun, "receipt.json"],
    [reviewerRun, "envelope.json"],
    [reviewerRun, "lifecycle.json"],
  ];
  for (const [run, file] of required)
    if (!existsSync(resolve(target, ".factory", "runs", run!, file!)))
      throw new Error("required remote evidence missing");
  const archivedRuns = new Set(
    names.map((name) => name.split("/")[2]).filter((name): name is string => Boolean(name)),
  );
  if (archivedRuns.size !== runs.length || runs.some((run) => !archivedRuns.has(run)))
    throw new Error("remote evidence has unexpected runs");
  const receipt = (
    run: string,
    role: "planner" | "worker" | "documenter" | "reviewer",
    requiredArtifacts: string[],
  ): Record<string, unknown> | undefined => {
    const value = json(resolve(target, ".factory", "runs", run, "receipt.json"));
    if (
      !isRecord(value) ||
      value.runId !== run ||
      value.status !== "completed" ||
      value.baseSha !== expected.baseSha ||
      !isRecord(value.agent) ||
      value.agent.name !== role ||
      !Array.isArray(value.artifacts)
    )
      return undefined;
    const artifacts: unknown[] = value.artifacts;
    if (
      !requiredArtifacts.every(
        (name) =>
          artifacts.includes(name) && existsSync(resolve(target, ".factory", "runs", run, name)),
      )
    )
      return undefined;
    return value;
  };
  const plannerReceipt = receipt(plannerRun, "planner", ["envelope.json", "plan.md"]);
  const workerReceipt = workerRun
    ? receipt(workerRun, "worker", [
        "envelope.json",
        "lifecycle.json",
        "verification.json",
        "review-diff.sha256",
      ])
    : undefined;
  const documenterReceipt = receipt(documenterRun, "documenter", [
    "envelope.json",
    ...(docsOnly ? ["lifecycle.json", "verification.json", "review-diff.sha256"] : []),
  ]);
  const reviewerReceipt = receipt(reviewerRun, "reviewer", ["envelope.json", "lifecycle.json"]);
  const planner = parseEnvelope(
    "planner",
    json(resolve(target, ".factory", "runs", plannerRun, "envelope.json")),
  );
  const workerEnvelope = workerRun
    ? parseEnvelope("worker", json(resolve(target, ".factory", "runs", workerRun, "envelope.json")))
    : undefined;
  const worker = json(resolve(target, ".factory", "runs", primaryRun, "lifecycle.json"));
  const verification = json(resolve(target, ".factory", "runs", primaryRun, "verification.json"));
  const documenter = parseEnvelope(
    "documenter",
    json(resolve(target, ".factory", "runs", documenterRun, "envelope.json")),
  );
  const reviewerLifecycle = json(
    resolve(target, ".factory", "runs", reviewerRun, "lifecycle.json"),
  );
  const reviewer = parseEnvelope(
    "reviewer",
    json(resolve(target, ".factory", "runs", reviewerRun, "envelope.json")),
  );
  const allowed = new Set(expected.allowedPaths.map(assertSafeRepoPath));
  const pathAllowed = (path: unknown): path is string =>
    typeof path === "string" &&
    (() => {
      const safe = assertSafeRepoPath(path);
      return [...allowed].some((prefix) => safe === prefix || safe.startsWith(`${prefix}/`));
    })();
  const verificationConfig =
    isRecord(verification) && isRecord(verification.config) ? verification.config : undefined;
  const configuredCommands =
    verificationConfig && Array.isArray(verificationConfig.commands)
      ? verificationConfig.commands
      : undefined;
  const commandsPass =
    isRecord(verification) &&
    configuredCommands !== undefined &&
    Array.isArray(verification.commands) &&
    verification.commands.length > 0 &&
    configuredCommands.length === verification.commands.length &&
    verification.commands.every(
      (command, index) =>
        isRecord(command) &&
        Array.isArray(command.argv) &&
        command.argv.length > 0 &&
        command.argv.every((part) => typeof part === "string" && part.length > 0) &&
        JSON.stringify(configuredCommands[index]) === JSON.stringify(command.argv) &&
        command.exitCode === 0 &&
        command.timedOut === false,
    );
  const reviewedDigest = readFileSync(
    resolve(target, ".factory", "runs", primaryRun, "review-diff.sha256"),
    "utf8",
  ).trim();
  const plannerPaths = planner.ok
    ? planner.envelope.changes.map((change) => assertSafeRepoPath(change.path))
    : [];
  const verifiedPaths =
    isRecord(verification) &&
    isRecord(verification.git) &&
    Array.isArray(verification.git.changedPaths)
      ? claimedPaths(
          verification.git.changedPaths.filter((path): path is string => typeof path === "string"),
        )
      : undefined;
  const workerClaims = workerEnvelope?.ok
    ? claimedPaths(workerEnvelope.envelope.changedFiles)
    : undefined;
  const documenterClaims = documenter.ok
    ? claimedPaths(documenter.envelope.changedFiles)
    : undefined;
  const lifecycleLinks =
    isRecord(worker) &&
    isRecord(reviewerLifecycle) &&
    worker.status === "completed" &&
    worker.stage === "reviewer" &&
    worker.baseSha === expected.baseSha &&
    worker.documenterRunId === documenterRun &&
    worker.reviewerRunId === reviewerRun &&
    typeof worker.documenterRunDir === "string" &&
    basename(worker.documenterRunDir) === documenterRun &&
    typeof worker.reviewerRunDir === "string" &&
    basename(worker.reviewerRunDir) === reviewerRun &&
    worker.reviewPatchSha256 === expected.patchSha256 &&
    reviewerLifecycle.status === "completed" &&
    reviewerLifecycle.stage === "reviewer" &&
    reviewerLifecycle.baseSha === expected.baseSha &&
    reviewerLifecycle.documenterRunId === documenterRun &&
    reviewerLifecycle.reviewerRunId === reviewerRun &&
    reviewerLifecycle.reviewPatchSha256 === expected.patchSha256 &&
    (docsOnly
      ? worker.workerRunId === undefined && reviewerLifecycle.workerRunId === undefined
      : worker.workerRunId === workerRun && reviewerLifecycle.workerRunId === workerRun) &&
    Array.isArray(worker.allowedPaths) &&
    worker.allowedPaths.length === allowed.size &&
    worker.allowedPaths.every((path) => typeof path === "string" && allowed.has(path)) &&
    JSON.stringify(worker.verification) === JSON.stringify(verification) &&
    JSON.stringify(reviewerLifecycle.verification) === JSON.stringify(verification);
  if (
    !plannerReceipt ||
    (!docsOnly && !workerReceipt) ||
    !documenterReceipt ||
    !reviewerReceipt ||
    (!docsOnly && reviewerReceipt.workerRunId !== workerRun) ||
    (docsOnly && reviewerReceipt.workerRunId !== undefined) ||
    reviewerReceipt.documenterRunId !== documenterRun ||
    !planner.ok ||
    planner.envelope.decisionsNeeded.length > 0 ||
    plannerPaths.length !== allowed.size ||
    !plannerPaths.every((path) => allowed.has(path)) ||
    !lifecycleLinks ||
    !verifiedPaths ||
    (!docsOnly &&
      (!workerEnvelope?.ok ||
        !workerClaims ||
        JSON.stringify(workerClaims) !==
          JSON.stringify(verifiedPaths.filter((path) => !isDocs(path))))) ||
    !documenterClaims ||
    JSON.stringify(documenterClaims) !== JSON.stringify(verifiedPaths.filter(isDocs)) ||
    (documenter.ok &&
      (documenter.envelope.outcome === "updated") !== documenterClaims.length > 0) ||
    reviewedDigest !== expected.patchSha256 ||
    !isRecord(verification) ||
    verification.passed !== true ||
    !commandsPass ||
    !isRecord(verification.git) ||
    verification.git.passed !== true ||
    verification.git.baseSha !== expected.baseSha ||
    verification.git.headSha !== expected.baseSha ||
    !Array.isArray(verification.git.changedPaths) ||
    verification.git.changedPaths.length === 0 ||
    !verification.git.changedPaths.every(pathAllowed) ||
    !Array.isArray(verification.git.unexpectedPaths) ||
    verification.git.unexpectedPaths.length !== 0 ||
    verification.git.reason !== null ||
    !documenter.ok ||
    documenter.envelope.outcome === "blocked" ||
    !reviewer.ok ||
    reviewer.envelope.verdict !== "PASS"
  ) {
    throw new Error("remote lifecycle did not pass");
  }
  const manifest: Record<string, string> = {};
  for (const name of names) {
    const path = resolve(target, name);
    if (existsSync(path) && statSync(path).isFile()) manifest[name] = hash(path);
  }
  writeJson(resolve(runDir, "evidence-manifest.json"), manifest);
}
function archiveFactory(factoryRoot: string): { path: string; sha: string; cleanup(): void } {
  const directory = mkdtempSync(resolve(tmpdir(), "factory-runtime-"));
  const path = resolve(directory, "runtime.tar");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: factoryRoot,
    encoding: "utf8",
  }).trim();
  const data = execFileSync("git", ["archive", "--format=tar", "HEAD"], { cwd: factoryRoot });
  writeFileSync(path, data, { mode: 0o600 });
  return { path, sha, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
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
  const attempts = resolve(root, ".factory", "attempts");
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
  const controllers = resolve(root, ".factory", "controllers");
  if (!existsSync(controllers)) return;
  recoverStaleControllerClaims(controllers);
  for (const state of scanRecoverableControllerStates(controllers)) {
    const runDir = resolve(controllers, state.runId);
    const name =
      state.vm?.name ?? (state.state === "creating_vm" ? vmName(state.runId) : undefined);
    let cleanup = state.cleanup;
    if (name) {
      const result = await exe.destroyVm(name);
      if (!result.destroyed && !result.notFound)
        throw new Error("controller recovery cleanup failed");
      cleanup = "complete";
      recordControllerCleanup(runDir, "complete");
    }
    transitionControllerState(runDir, "failed");

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
      telemetry.append({
        type: "failure",
        actor: "controller",
        payload: { stage: "recovery", message: "abandoned controller run" },
      });
      telemetry.append({
        type: "run_finished",
        actor: "controller",
        payload: { status: "failed", cleanup },
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
  if (options.identity) requireAbsolute(options.identity);
  safeRepo(options.owner, options.repo);
  const root = resolve(options.root ?? process.cwd());
  const factoryRoot = resolve(options.factoryRoot ?? process.cwd());
  const exe = options.exe ?? new ExeClient(undefined, 30_000, options.identity);
  const lock = acquireControllerLock(root);
  const runId = options.runId ?? randomUUID();
  const provisional = resolve(root, ".factory", "attempts", runId);
  const startedAt = new Date().toISOString();
  let telemetry: TelemetryWriter;
  let telemetryBroken = false;
  let failure: string | undefined;
  try {
    telemetry = (options.telemetry ?? createTelemetryWriter)(root, runId);
    telemetry.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    telemetry.append({ type: "run_started", actor: "controller", payload: { status: "running" } });
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
  } catch (error) {
    lock.release();
    throw error;
  }
  let evidenceDir = provisional;
  let state: ControllerState | undefined;
  let archive: ReturnType<typeof archiveFactory> | undefined;
  let intakeSnapshot: Awaited<ReturnType<typeof createIntake>> | undefined;
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
    bestEffortEmit({
      type: "heartbeat",
      actor: "controller",
      ...(state
        ? { phase: { id: `${state.state}:1`, name: state.state, attempt: 1 as const } }
        : {}),
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
  ): ControllerState => {
    closeHostPhase();
    const nextState = transitionControllerState(runDir, next);
    state = nextState;
    emit({
      type: "phase_started",
      actor,
      phase: { id: `${next}:1`, name: next, attempt: 1 },
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
    const intake = await (options.intake ?? createIntake)(
      { token: options.linearToken, issue: options.issue },
      {
        token: options.githubToken,
        owner: options.owner,
        repo: options.repo,
        baseRef: options.baseRef,
      },
    );
    intakeSnapshot = intake;
    const runDir = resolve(root, ".factory", "controllers", runId);
    writeFileSync(
      resolve(provisional, "issue.md"),
      `${intake.issue.title}\n\n${intake.issue.description}\n`,
      { mode: 0o600 },
    );
    writeJson(resolve(provisional, "intake.json"), {
      issue: intake.issue,
      repository: intake.repository,
      idempotencyKey: intake.idempotencyKey,
    });
    stage = "state";
    state = createControllerState(runDir, {
      runId: basename(runDir),
      idempotencyKey: intake.idempotencyKey,
      issueUuid: intake.issue.uuid,
      issueSnapshotSha256: intake.issue.snapshotSha256,
      repositoryId: intake.repository.repositoryId,
      repositoryFullName: intake.repository.fullName,
      repositorySnapshotSha256: intake.repository.snapshotSha256,
      baseRef: intake.repository.baseRef,
      baseSha: intake.repository.baseSha,
    });
    for (const name of ["receipt.json", "issue.md", "intake.json"]) {
      renameSync(resolve(provisional, name), resolve(runDir, name));
    }
    rmSync(provisional, { recursive: true, force: true });
    evidenceDir = runDir;
    advance(runDir, "creating_vm");
    const vm = await exe.createVm({ name: vmName(state.runId), tag: options.tag });
    state = recordControllerVm(runDir, { name: vm.vmName, sshDest: vm.sshDest, status: vm.status });
    cleanupOutcome = "pending";
    emit({ type: "cleanup_updated", actor: "controller", payload: { cleanup: "pending" } });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await remote(exe, vm.sshDest, ["true"], 30_000);
        break;
      } catch (error) {
        if (attempt === 11) throw error;
        await (
          options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)))
        )(5_000);
      }
    }
    advance(runDir, "bootstrapping");
    publicFailureMessage = "repository clone failed";
    await remote(
      exe,
      vm.sshDest,
      ["git", "clone", `https://github.int.exe.xyz/${state.repositoryFullName}.git`, REMOTE_WORK],
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
    publicFailureMessage = "runtime archive creation failed";
    archive = archiveFactory(factoryRoot);
    writeJson(resolve(runDir, "runtime.json"), {
      factorySha: archive.sha,
      sha256: hash(archive.path),
    });
    const archivedRole = (role: "planner" | "worker" | "documenter" | "reviewer") => {
      const filePath = `src/agents/${role}.md`;
      const source = execFileSync("git", ["show", `${archive!.sha}:${filePath}`], {
        cwd: factoryRoot,
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
    const configDir = mkdtempSync(resolve(tmpdir(), "factory-pi-"));
    try {
      const models = resolve(configDir, "models.json");
      writeJson(models, { providers: { openrouter: { apiKey: options.openRouterKey } } });
      chmodSync(models, 0o600);
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
          REMOTE_FACTORY,
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
      const bunVersion = (await remote(exe, vm.sshDest, [REMOTE_BUN, "--version"], 30_000)).trim();
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
      await remote(exe, vm.sshDest, ["chmod", "600", "/home/exedev/.pi/agent/models.json"], 30_000);
      publicFailureMessage = "runtime installation failed";
      await remote(
        exe,
        vm.sshDest,
        ["tar", "-xf", "/home/exedev/runtime.tar", "-C", REMOTE_FACTORY],
        60_000,
      );
      await remote(exe, vm.sshDest, [REMOTE_NODE, "--version"], 30_000);
      publicFailureMessage = "Factory dependency installation failed";
      await remote(
        exe,
        vm.sshDest,
        [
          "env",
          "-C",
          REMOTE_FACTORY,
          `PATH=${REMOTE_PATH}`,
          REMOTE_BUN,
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
        ],
        300_000,
      );
      publicFailureMessage = "Factory build failed";
      await remote(
        exe,
        vm.sshDest,
        ["env", "-C", REMOTE_FACTORY, `PATH=${REMOTE_PATH}`, REMOTE_BUN, "run", "build"],
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
      publicFailureMessage = "OpenRouter readiness check failed";
      await remote(
        exe,
        vm.sshDest,
        ["curl", "-fsS", "-o", "/dev/null", "https://openrouter.ai/api/v1/models"],
        30_000,
      );
      let nextPublicToolId = 1;
      const remoteSequence = (
        expected: Array<"planning" | "implementing" | "documenting" | "verifying" | "reviewing">,
      ) => {
        let index = 0;
        let open: (typeof expected)[number] | undefined;
        let terminated = false;
        let negative = false;
        let pendingNegativeClosure: "failed" | "timed_out" | undefined;
        let gateSeen = false;
        let reviewSeen = false;
        const tools = new Map<string, { publicId: string; name: string }>();
        const allowedTools: Record<RemoteEvent["actor"], Set<string>> = {
          planner: new Set([...archivedRoles.planner.tools, "submit_envelope"]),
          worker: new Set([...archivedRoles.worker.tools, "submit_envelope"]),
          documenter: new Set([...archivedRoles.documenter.tools, "submit_envelope"]),
          verifier: new Set(),
          reviewer: new Set([...archivedRoles.reviewer.tools, "submit_envelope"]),
        };
        const contextSeen = new Set<RemotePhase>();
        const usageSeen = new Set<RemotePhase>();
        const agentStarted = new Set<RemotePhase>();
        const agentFinished = new Map<RemotePhase, "completed" | "failed" | "timed_out">();
        const closeOpen = (status: "failed" | "timed_out" = "failed"): void => {
          if (!open) return;
          const actor = PHASE_OWNER[open];
          emit({
            type: "phase_finished",
            actor,
            phase: telemetryPhase(open),
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
          const owner = PHASE_OWNER[event.phase];
          if (event.actor !== owner) throw new Error("invalid remote phase owner");
          if (event.type === "phase_started") {
            if (open || event.phase !== expected[index])
              throw new Error("invalid remote phase sequence");
            open = event.phase;
            advance(runDir, event.phase, event.actor, sourceAt);
            if (event.actor !== "verifier") {
              const role = archivedRoles[event.actor];
              emit({
                type: "agent_context",
                actor: event.actor,
                phase: telemetryPhase(event.phase),
                payload: {
                  model: role.model,
                  description: role.description,
                  tools: [...role.tools, "submit_envelope"],
                  thinking: role.thinking,
                  access: role.access,
                  systemPromptSha256: createHash("sha256").update(role.systemPrompt).digest("hex"),
                },
              });
              contextSeen.add(event.phase);
            }
            return;
          }
          if (!open || event.phase !== open) throw new Error("remote event outside active phase");
          if (
            usageSeen.has(event.phase) &&
            ["agent_started", "agent_finished", "tool_started", "tool_finished"].includes(
              event.type,
            )
          )
            throw new Error("remote agent activity after usage");
          const phase = telemetryPhase(event.phase);
          switch (event.type) {
            case "phase_finished":
              if (tools.size) throw new Error("remote phase finished with active tool calls");
              if (
                event.actor !== "verifier" &&
                event.status === "completed" &&
                (agentFinished.get(event.phase) !== "completed" || !usageSeen.has(event.phase))
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
              if (agentStarted.has(event.phase) || agentFinished.has(event.phase))
                throw new Error("invalid remote agent lifecycle");
              agentStarted.add(event.phase);
              emit({ type: "agent_started", actor: event.actor, phase, sourceAt, payload: {} });
              break;
            case "agent_finished":
              if (!agentStarted.has(event.phase) || agentFinished.has(event.phase))
                throw new Error("invalid remote agent lifecycle");
              agentFinished.set(event.phase, event.status);
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
                !contextSeen.has(event.phase) ||
                agentFinished.get(event.phase) !== "completed" ||
                tools.size ||
                usageSeen.has(event.phase)
              )
                throw new Error("invalid remote agent usage");
              usageSeen.add(event.phase);
              emit({
                type: "agent_usage",
                actor: event.actor,
                phase,
                sourceAt,
                payload: {
                  ...event.tokens,
                  ...(event.reportedCostNanoUsd === undefined
                    ? {}
                    : { reportedCostNanoUsd: event.reportedCostNanoUsd }),
                },
              });
              break;
            case "tool_started": {
              if (!allowedTools[event.actor].has(event.toolName) || tools.has(event.toolCallId))
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
              if (!tool || tool.name !== event.toolName)
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
                (expected.includes("verifying") && !gateSeen) ||
                (expected.includes("reviewing") && !reviewSeen))
            )
              throw new Error("remote completed result contradicts phase evidence");
          },
        };
      };
      const issue = "/home/exedev/issue.md";
      await exe.copyTo(vm.sshDest, resolve(runDir, "issue.md"), issue);
      const plannerSequence = remoteSequence(["planning"]);
      let plannerResult: RemoteResultFrame;
      try {
        plannerResult = await streamed(
          exe,
          vm.sshDest,
          [
            "env",
            "-C",
            REMOTE_FACTORY,
            `PATH=${REMOTE_PATH}`,
            `${REMOTE_FACTORY}/dist/factory`,
            "pi",
            "plan",
            "--repo",
            REMOTE_WORK,
            "--issue",
            issue,
            "--timeout-seconds",
            String(options.timeoutSeconds),
            "--machine",
          ],
          options.timeoutSeconds * 1000 + 60_000,
          plannerSequence.onEvent,
        );
        plannerSequence.finish(plannerResult);
      } catch (error) {
        plannerSequence.closeOpen();
        throw error;
      }
      const plannerRun = outputPath(plannerResult.runDir, "Run evidence");
      if (plannerResult.status !== "completed") throw new Error("remote planner failed");
      const plannerEnvelope = JSON.parse(
        await remote(exe, vm.sshDest, ["cat", `${plannerRun}/envelope.json`], 30_000),
      ) as unknown;
      const parsedPlan = parseEnvelope("planner", plannerEnvelope);
      if (!parsedPlan.ok || parsedPlan.envelope.decisionsNeeded.length)
        throw new Error("remote planner envelope is blocked");
      const hasWorker = parsedPlan.envelope.changes.some((change) => {
        const path = assertSafeRepoPath(change.path);
        return path !== "docs" && !path.startsWith("docs/");
      });
      const workerSequence = remoteSequence([
        ...(hasWorker ? (["implementing"] as const) : []),
        "documenting",
        "verifying",
        "reviewing",
      ]);
      let workerResult: RemoteResultFrame;
      try {
        workerResult = await streamed(
          exe,
          vm.sshDest,
          [
            "env",
            "-C",
            REMOTE_FACTORY,
            `PATH=${REMOTE_PATH}`,
            `${REMOTE_FACTORY}/dist/factory`,
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
      if (workerResult.status !== "completed") throw new Error("remote worker lifecycle failed");
      const lifecycle: unknown = JSON.parse(
        await remote(exe, vm.sshDest, ["cat", `${workerRun}/lifecycle.json`], 30_000),
      );
      const documenterRun = outputPath(
        isRecord(lifecycle) && typeof lifecycle.documenterRunDir === "string"
          ? lifecycle.documenterRunDir
          : undefined,
        "Documenter evidence",
      );
      const reviewerRun = outputPath(workerResult.reviewerRunDir, "Reviewer evidence");
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
      await remote(
        exe,
        vm.sshDest,
        ["tar", "-cf", "/home/exedev/evidence.tar", "-C", REMOTE_FACTORY, ".factory/runs"],
        60_000,
      );
      await exe.copyFrom(vm.sshDest, "/home/exedev/evidence.tar", resolve(runDir, "evidence.tar"));
      chmodSync(resolve(runDir, "evidence.tar"), 0o600);
      assertArtifactSafe(
        resolve(runDir, "evidence.tar"),
        [options.openRouterKey],
        "evidence archive",
      );
      const runIds = [
        plannerRun,
        ...(hasWorker ? [workerRun] : []),
        documenterRun,
        reviewerRun,
      ].map((path) => basename(path));
      harvest(resolve(runDir, "evidence.tar"), runDir, runIds, {
        baseSha: state.baseSha,
        allowedPaths: parsedPlan.envelope.changes.map((change) => change.path),
        patchSha256,
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
    bestEffortEmit({
      type: "failure",
      actor: "controller",
      payload: { stage, message: publicFailureMessage },
    });
  }
  if (failure && state?.vm) {
    const runDir = resolve(root, ".factory", "controllers", state.runId);
    const target = resolve(runDir, "failure-evidence.tar");
    try {
      await remote(
        exe,
        state.vm.sshDest,
        ["tar", "-cf", "/home/exedev/evidence.tar", "-C", REMOTE_FACTORY, ".factory/runs"],
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
    const cleanupRequired = state !== undefined && state.state !== "intake";
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
        resolve(root, ".factory", "controllers", state.runId),
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
          resolve(root, ".factory", "controllers", state.runId),
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
    const runDir = state ? resolve(root, ".factory", "controllers", state.runId) : evidenceDir;
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
      if (state && !cleanupFailed && state.state !== "failed") {
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

    if (!state || failure) {
      result = failedResult(failure ?? "intake failed");
    } else {
      try {
        if (!intakeSnapshot || !reviewedPatchSha256)
          throw new Error("publication evidence is incomplete");
        advance(runDir, "ready_for_publication");
        advance(runDir, "publishing");
        const pullRequest = await (options.publish ?? publishGitHubPullRequest)({
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
        });
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
          pullRequest,
        });
        emit({
          type: "run_finished",
          actor: "controller",
          payload: { status: "completed", cleanup: "complete" },
        });
        result = { status: "completed", runDir, pullRequest };
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
