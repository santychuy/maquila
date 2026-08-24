import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { controllerChildEnvironment, resolveControllerCredentials } from "./credentials.js";
import { runControllerChain } from "./controller-chain.js";
import type { ControllerResult } from "./controller.js";
import { handshakePath, LAUNCH_INSTANCE_ENV, readLaunchHandshake } from "./run-launcher.js";
import { cliInvocation } from "./runtime.js";
import { sanitizeTelemetryText } from "./telemetry.js";
import { validateResolvedTarget } from "./target.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISSUE = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
const ITEM_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
const BATCH_STATUSES = ["queued", "running", "completed", "failed"] as const;

export type BatchItemStatus = (typeof ITEM_STATUSES)[number];
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export interface BatchItem {
  issue: string;
  runId: string;
  status: BatchItemStatus;
  error?: string;
}

export interface BatchState {
  version: 1;
  batchId: string;
  status: BatchStatus;
  target: { owner: string; repo: string; baseRef: string; tag: string };
  timeoutSeconds: number;
  createdAt: string;
  updatedAt: string;
  items: BatchItem[];
}

export interface CreateBatchOptions {
  root: string;
  issues: string[];
  target: BatchState["target"];
  timeoutSeconds: number;
  batchId?: string;
  runIds?: string[];
}

export interface RunBatchOptions {
  root: string;
  maquilaRoot: string;
  batchId: string;
  linearToken: string;
  githubToken: string;
  openRouterKey: string;
  identity?: string;
  run?: typeof runControllerChain;
  onAccepted?: () => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function safeTarget(value: unknown): value is BatchState["target"] {
  if (
    !record(value) ||
    !exactKeys(value, ["owner", "repo", "baseRef", "tag"]) ||
    typeof value.owner !== "string" ||
    typeof value.repo !== "string" ||
    typeof value.baseRef !== "string" ||
    typeof value.tag !== "string"
  )
    return false;
  try {
    validateResolvedTarget({
      owner: value.owner,
      repo: value.repo,
      baseRef: value.baseRef,
      tag: value.tag,
    });
    return true;
  } catch {
    return false;
  }
}

function safeItem(value: unknown): value is BatchItem {
  return (
    record(value) &&
    exactKeys(value, ["issue", "runId", "status", "error"]) &&
    typeof value.issue === "string" &&
    ISSUE.test(value.issue) &&
    typeof value.runId === "string" &&
    UUID.test(value.runId) &&
    typeof value.status === "string" &&
    ITEM_STATUSES.some((status) => status === value.status) &&
    (value.error === undefined || (typeof value.error === "string" && value.error.length > 0))
  );
}

export function isBatchState(value: unknown): value is BatchState {
  if (
    !record(value) ||
    !exactKeys(value, [
      "version",
      "batchId",
      "status",
      "target",
      "timeoutSeconds",
      "createdAt",
      "updatedAt",
      "items",
    ]) ||
    value.version !== 1 ||
    typeof value.batchId !== "string" ||
    !UUID.test(value.batchId) ||
    typeof value.status !== "string" ||
    !BATCH_STATUSES.some((status) => status === value.status) ||
    !safeTarget(value.target) ||
    typeof value.timeoutSeconds !== "number" ||
    !Number.isInteger(value.timeoutSeconds) ||
    value.timeoutSeconds < 1 ||
    value.timeoutSeconds > 1800 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !Array.isArray(value.items) ||
    value.items.length < 2 ||
    value.items.length > 10 ||
    !value.items.every(safeItem)
  )
    return false;
  if (
    new Set(value.items.map((item) => item.issue)).size !== value.items.length ||
    new Set(value.items.map((item) => item.runId)).size !== value.items.length
  )
    return false;
  if (value.status === "queued") return value.items.every((item) => item.status === "queued");
  if (value.status === "completed")
    return value.items.every((item) => item.status !== "queued" && item.status !== "running");
  let queued = false;
  let running = false;
  for (const item of value.items) {
    if (item.status === "queued") queued = true;
    else if (queued) return false;
    if (item.status === "running") {
      if (running) return false;
      running = true;
    }
  }
  return value.status === "running" || (!running && value.items.some((item) => item.error));
}

export function batchDirectory(root: string, batchId: string): string {
  if (!UUID.test(batchId)) throw new Error("invalid batch ID");
  return resolve(root, ".maquila", "batches", batchId);
}

export function batchStatePath(root: string, batchId: string): string {
  return resolve(batchDirectory(root, batchId), "batch.json");
}

function writeBatchState(root: string, state: BatchState): void {
  if (!isBatchState(state)) throw new Error("invalid batch state");
  const directory = batchDirectory(root, state.batchId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = batchStatePath(root, state.batchId);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readBatchState(root: string, batchId: string): BatchState {
  const path = batchStatePath(root, batchId);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isBatchState(value) ||
    value.batchId !== batchId ||
    basename(resolve(path, "..")) !== batchId
  )
    throw new Error("invalid batch state");
  return value;
}

export function createBatch(options: CreateBatchOptions): BatchState {
  const issues = options.issues.map((issue) => issue.trim());
  if (
    issues.length < 2 ||
    issues.length > 10 ||
    issues.some((issue) => !ISSUE.test(issue)) ||
    new Set(issues).size !== issues.length
  )
    throw new Error("batch requires 2 to 10 unique Linear issue IDs");
  if (
    !Number.isInteger(options.timeoutSeconds) ||
    options.timeoutSeconds < 1 ||
    options.timeoutSeconds > 1800
  )
    throw new Error("--timeout-seconds must be an integer from 1 to 1800");
  const batchId = options.batchId ?? randomUUID();
  const runIds = options.runIds ?? issues.map(() => randomUUID());
  if (
    !UUID.test(batchId) ||
    runIds.length !== issues.length ||
    runIds.some((runId) => !UUID.test(runId)) ||
    new Set(runIds).size !== runIds.length
  )
    throw new Error("invalid batch identity");
  if (existsSync(batchDirectory(options.root, batchId))) throw new Error("batch already exists");
  const now = new Date().toISOString();
  const state: BatchState = {
    version: 1,
    batchId,
    status: "queued",
    target: options.target,
    timeoutSeconds: options.timeoutSeconds,
    createdAt: now,
    updatedAt: now,
    items: issues.map((issue, index) => ({ issue, runId: runIds[index]!, status: "queued" })),
  };
  writeBatchState(options.root, state);
  return state;
}

function resultStatus(result: ControllerResult): Exclude<BatchItemStatus, "queued" | "running"> {
  return result.status === "awaiting_decision" ? "failed" : result.status;
}

export async function runBatch(options: RunBatchOptions): Promise<BatchState> {
  let state = readBatchState(options.root, options.batchId);
  if (state.status !== "queued") throw new Error("batch is not queued");
  const run = options.run ?? runControllerChain;
  const secrets = [options.linearToken, options.githubToken, options.openRouterKey];

  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index]!;
    let itemAccepted = false;
    try {
      const result = await run({
        issue: item.issue,
        ...state.target,
        timeoutSeconds: state.timeoutSeconds,
        linearToken: options.linearToken,
        githubToken: options.githubToken,
        openRouterKey: options.openRouterKey,
        root: options.root,
        maquilaRoot: options.maquilaRoot,
        runId: item.runId,
        ...(options.identity ? { identity: options.identity } : {}),
        onAccepted: () => {
          itemAccepted = true;
          state = {
            ...state,
            status: "running",
            updatedAt: new Date().toISOString(),
            items: state.items.map((entry, entryIndex) =>
              entryIndex === index ? { ...entry, status: "running" } : entry,
            ),
          };
          writeBatchState(options.root, state);
          if (index === 0) options.onAccepted?.();
        },
      });
      state = {
        ...state,
        updatedAt: new Date().toISOString(),
        items: state.items.map((entry, entryIndex) =>
          entryIndex === index ? { ...entry, status: resultStatus(result) } : entry,
        ),
      };
      writeBatchState(options.root, state);
    } catch (error) {
      const message = sanitizeTelemetryText(
        error instanceof Error ? error.message : String(error),
        secrets,
      );
      state = {
        ...state,
        status: itemAccepted ? "running" : "failed",
        updatedAt: new Date().toISOString(),
        items: state.items.map((entry, entryIndex) =>
          entryIndex === index ? { ...entry, status: "failed", error: message } : entry,
        ),
      };
      writeBatchState(options.root, state);
      if (!itemAccepted) throw error;
    }
  }

  state = { ...state, status: "completed", updatedAt: new Date().toISOString() };
  writeBatchState(options.root, state);
  return state;
}

interface SpawnedBatch {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface StartDetachedBatchOptions {
  root: string;
  batchId: string;
  identity?: string;
  env?: NodeJS.ProcessEnv;
  cliPath?: string;
  instanceId?: string;
  startupTimeoutMs?: number;
  terminationTimeoutMs?: number;
  spawnChild?: (
    command: string,
    args: string[],
    options: Parameters<typeof spawn>[2],
  ) => SpawnedBatch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface BatchStartResult {
  version: 1;
  accepted: true;
  batchId: string;
  status: "running";
  runs: Array<{ issue: string; runId: string }>;
}

export function batchTerminationUnconfirmedPath(root: string, batchId: string): string {
  return resolve(batchDirectory(root, batchId), "termination-unconfirmed.json");
}

function recordTerminationUnconfirmed(
  root: string,
  batchId: string,
  instanceId: string,
  pid: number | undefined,
): void {
  writeFileSync(
    batchTerminationUnconfirmedPath(root, batchId),
    `${JSON.stringify({
      version: 1,
      batchId,
      instanceId,
      pid: pid && pid > 0 ? pid : null,
      status: "termination_unconfirmed",
      recordedAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600, flag: "wx" },
  );
}

function exited(child: SpawnedBatch): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function startDetachedBatch(
  options: StartDetachedBatchOptions,
): Promise<BatchStartResult> {
  const state = readBatchState(options.root, options.batchId);
  if (state.status !== "queued") throw new Error("batch is not queued");
  const credentials = await resolveControllerCredentials({
    env: options.env ?? process.env,
    identityFlag: options.identity,
  });
  const instanceId = options.instanceId ?? randomUUID();
  if (!UUID.test(instanceId)) throw new Error("invalid launch identity");
  const environment = {
    ...controllerChildEnvironment(options.env ?? process.env, credentials),
    [LAUNCH_INSTANCE_ENV]: instanceId,
  };
  const directory = batchDirectory(options.root, options.batchId);
  const stdout = openSync(resolve(directory, "coordinator.stdout.log"), "wx", 0o600);
  const stderr = openSync(resolve(directory, "coordinator.stderr.log"), "wx", 0o600);
  const invocation = cliInvocation(resolve(options.cliPath ?? process.argv[1]!), [
    "run",
    "batch",
    "execute",
    "--batch-id",
    options.batchId,
  ]);
  let child: SpawnedBatch;
  try {
    child = (
      options.spawnChild ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions))
    )(invocation.command, invocation.args, {
      cwd: resolve(options.root),
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env: environment,
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));
  const deadline = Date.now() + (options.startupTimeoutMs ?? 5000);
  for (;;) {
    const handshake = existsSync(handshakePath(options.root, options.batchId))
      ? readLaunchHandshake(handshakePath(options.root, options.batchId))
      : undefined;
    if (
      handshake?.runId === options.batchId &&
      handshake.instanceId === instanceId &&
      handshake.pid === child.pid
    ) {
      child.unref();
      return {
        version: 1,
        accepted: true,
        batchId: options.batchId,
        status: "running",
        runs: state.items.map(({ issue, runId }) => ({ issue, runId })),
      };
    }
    if (spawnError || exited(child) || Date.now() >= deadline) {
      if (!exited(child)) {
        child.kill("SIGTERM");
        const terminateBy = Date.now() + (options.terminationTimeoutMs ?? 1000);
        while (!exited(child) && Date.now() < terminateBy) await sleep(25);
        if (!exited(child)) {
          child.kill("SIGKILL");
          const killBy = Date.now() + (options.terminationTimeoutMs ?? 1000);
          while (!exited(child) && Date.now() < killBy) await sleep(25);
        }
      }
      if (!exited(child))
        recordTerminationUnconfirmed(options.root, options.batchId, instanceId, child.pid);
      child.unref();
      if (!exited(child))
        throw new Error(`batch coordinator termination unconfirmed for batch ${options.batchId}`);
      throw new Error(
        spawnError ? "batch coordinator could not start" : "batch coordinator rejected startup",
      );
    }
    await sleep(25);
  }
}
