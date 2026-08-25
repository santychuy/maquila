import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { parseEnvelope } from "../envelope.js";
import { assertSafeRepoPath } from "../verify.js";
import {
  assertFeaturePrExecution,
  completedExecutionRunIds,
  completedStepRunId,
  implementRunId,
  parseWorkflowExecution,
  primaryRunId,
  type WorkflowExecution,
} from "../workflows/execution.js";
import { isDocumentationPath } from "../workflows/feature-pr.js";
import type { WorkflowManifest } from "../workflows/manifest.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function json(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function claimedPaths(paths: string[]): string[] | undefined {
  try {
    const safe = paths.map(assertSafeRepoPath);
    return new Set(safe).size === safe.length ? safe.toSorted() : undefined;
  } catch {
    return undefined;
  }
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

export interface HarvestExpectations {
  manifest: WorkflowManifest;
  execution: WorkflowExecution;
}

export function harvest(archive: string, runDir: string, expected: HarvestExpectations): void {
  const names = execFileSync("tar", ["-tf", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  if (
    !names.length ||
    names.some(
      (name) => !name.startsWith(".maquila/runs/") || name.includes("..") || name.startsWith("/"),
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
  assertFeaturePrExecution(expected.execution, expected.manifest);
  if (!UUID.test(expected.manifest.plannerRunId)) throw new Error("unsafe remote run id");
  const plannerRun = expected.manifest.plannerRunId;
  const workerRun = implementRunId(expected.execution);
  const docsOnly = workerRun === undefined;
  const documenterRun = completedStepRunId(expected.execution, "document");
  const reviewerRun = completedStepRunId(expected.execution, "review");
  const primaryRun = primaryRunId(expected.execution);
  const runs = [plannerRun, ...completedExecutionRunIds(expected.execution)];
  if (runs.some((run) => !UUID.test(run))) throw new Error("unsafe remote run id");
  if (new Set(runs).size !== runs.length) throw new Error("remote run ids must be distinct");
  const required = [
    [plannerRun, "receipt.json"],
    [plannerRun, "envelope.json"],
    [plannerRun, "plan.md"],
    [primaryRun, "receipt.json"],
    [primaryRun, "lifecycle.json"],
    [primaryRun, "verification.json"],
    [primaryRun, "review-diff.sha256"],
    [primaryRun, "workflow-execution.json"],
    [documenterRun, "envelope.json"],
    [reviewerRun, "receipt.json"],
    [reviewerRun, "envelope.json"],
    [reviewerRun, "lifecycle.json"],
  ];
  for (const [run, file] of required)
    if (!existsSync(resolve(target, ".maquila", "runs", run!, file!)))
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
    const value = json(resolve(target, ".maquila", "runs", run, "receipt.json"));
    if (
      !isRecord(value) ||
      value.runId !== run ||
      value.status !== "completed" ||
      value.baseSha !== expected.manifest.baseSha ||
      !isRecord(value.agent) ||
      value.agent.name !== role ||
      !Array.isArray(value.artifacts)
    )
      return undefined;
    const artifacts: unknown[] = value.artifacts;
    if (
      !requiredArtifacts.every(
        (name) =>
          artifacts.includes(name) && existsSync(resolve(target, ".maquila", "runs", run, name)),
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
        "workflow-execution.json",
      ])
    : undefined;
  const documenterReceipt = receipt(documenterRun, "documenter", [
    "envelope.json",
    ...(docsOnly
      ? ["lifecycle.json", "verification.json", "review-diff.sha256", "workflow-execution.json"]
      : []),
  ]);
  const reviewerReceipt = receipt(reviewerRun, "reviewer", ["envelope.json", "lifecycle.json"]);
  const planner = parseEnvelope(
    "planner",
    json(resolve(target, ".maquila", "runs", plannerRun, "envelope.json")),
  );
  const workerEnvelope = workerRun
    ? parseEnvelope("worker", json(resolve(target, ".maquila", "runs", workerRun, "envelope.json")))
    : undefined;
  const worker = json(resolve(target, ".maquila", "runs", primaryRun, "lifecycle.json"));
  const verification = json(resolve(target, ".maquila", "runs", primaryRun, "verification.json"));
  const documenter = parseEnvelope(
    "documenter",
    json(resolve(target, ".maquila", "runs", documenterRun, "envelope.json")),
  );
  const reviewerLifecycle = json(
    resolve(target, ".maquila", "runs", reviewerRun, "lifecycle.json"),
  );
  const reviewer = parseEnvelope(
    "reviewer",
    json(resolve(target, ".maquila", "runs", reviewerRun, "envelope.json")),
  );
  const archivedExecution = parseWorkflowExecution(
    json(resolve(target, ".maquila", "runs", primaryRun, "workflow-execution.json")),
  );
  if (JSON.stringify(archivedExecution) !== JSON.stringify(expected.execution))
    throw new Error("archived workflow execution does not match");
  const allowed = new Set(expected.manifest.allowedPaths.map(assertSafeRepoPath));
  const pathAllowed = (path: unknown): path is string =>
    typeof path === "string" &&
    (() => {
      const safe = assertSafeRepoPath(path);
      return [...allowed].some((prefix) => safe === prefix || safe.startsWith(`${prefix}/`));
    })();
  const pinnedCommands = expected.manifest.steps[2].code.commands;
  const commandsPass =
    isRecord(verification) &&
    Array.isArray(verification.commands) &&
    verification.commands.length === pinnedCommands.length &&
    verification.commands.every(
      (command, index) =>
        isRecord(command) &&
        Array.isArray(command.argv) &&
        command.argv.length > 0 &&
        command.argv.every((part) => typeof part === "string" && part.length > 0) &&
        JSON.stringify(pinnedCommands[index]) === JSON.stringify(command.argv) &&
        command.exitCode === 0 &&
        command.timedOut === false,
    );
  const reviewedDigest = readFileSync(
    resolve(target, ".maquila", "runs", primaryRun, "review-diff.sha256"),
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
    worker.baseSha === expected.manifest.baseSha &&
    worker.documenterRunId === documenterRun &&
    worker.reviewerRunId === reviewerRun &&
    typeof worker.documenterRunDir === "string" &&
    basename(worker.documenterRunDir) === documenterRun &&
    typeof worker.reviewerRunDir === "string" &&
    basename(worker.reviewerRunDir) === reviewerRun &&
    worker.reviewPatchSha256 === expected.execution.reviewedPatchSha256 &&
    reviewerLifecycle.status === "completed" &&
    reviewerLifecycle.stage === "reviewer" &&
    reviewerLifecycle.baseSha === expected.manifest.baseSha &&
    reviewerLifecycle.documenterRunId === documenterRun &&
    reviewerLifecycle.reviewerRunId === reviewerRun &&
    reviewerLifecycle.reviewPatchSha256 === expected.execution.reviewedPatchSha256 &&
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
          JSON.stringify(verifiedPaths.filter((path) => !isDocumentationPath(path))))) ||
    !documenterClaims ||
    JSON.stringify(documenterClaims) !==
      JSON.stringify(verifiedPaths.filter(isDocumentationPath)) ||
    (documenter.ok &&
      (documenter.envelope.outcome === "updated") !== documenterClaims.length > 0) ||
    reviewedDigest !== expected.execution.reviewedPatchSha256 ||
    !isRecord(verification) ||
    verification.passed !== true ||
    !commandsPass ||
    !isRecord(verification.git) ||
    verification.git.passed !== true ||
    verification.git.baseSha !== expected.manifest.baseSha ||
    verification.git.headSha !== expected.manifest.baseSha ||
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
