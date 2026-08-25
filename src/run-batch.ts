import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { controllerChildEnvironment, resolveControllerCredentials } from "./credentials.js";
import { runControllerChain } from "./controller-chain.js";
import type { ControllerResult } from "./controller.js";
import { handshakePath, LAUNCH_INSTANCE_ENV, readLaunchHandshake } from "./run-launcher.js";
import {
  batchDirectory,
  readBatchState,
  writeBatchState,
  type BatchItemStatus,
  type BatchState,
} from "./runs/batch-state.js";
import { cliInvocation } from "./runtime.js";
import { sanitizeTelemetryText } from "./telemetry.js";

export {
  batchDirectory,
  batchStatePath,
  createBatch,
  isBatchState,
  readBatchState,
  type BatchItem,
  type BatchItemStatus,
  type BatchState,
  type BatchStatus,
  type CreateBatchOptions,
} from "./runs/batch-state.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
