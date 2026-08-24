import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { controllerChildEnvironment, resolveControllerCredentials } from "./credentials.js";
import { telemetryPath } from "./telemetry.js";
import { cliInvocation } from "./runtime.js";
import { resolveTargetRepository, type TargetRepository } from "./target.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const LAUNCH_INSTANCE_ENV = "MAQUILA_LAUNCH_INSTANCE_ID";

export interface LaunchHandshake {
  version: 1;
  runId: string;
  instanceId: string;
  pid: number;
  acceptedAt: string;
}

export interface RunStartResult {
  version: 1;
  accepted: true;
  runId: string;
  status: "running";
}

interface TerminationUnconfirmed {
  version: 1;
  runId: string;
  instanceId: string;
  pid: number | null;
  status: "termination_unconfirmed";
  recordedAt: string;
}

interface SpawnedChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface StartDetachedRunOptions {
  maquilaRoot: string;
  target: string;
  issue: string;
  owner?: string;
  repo?: string;
  baseRef?: string;
  tag?: string;
  identity?: string;
  timeoutSeconds: number;
  env?: NodeJS.ProcessEnv;
  cliPath?: string;
  runId?: string;
  instanceId?: string;
  startupTimeoutMs?: number;
  terminationTimeoutMs?: number;
  resolveTarget?: (options: Parameters<typeof resolveTargetRepository>[0]) => TargetRepository;
  spawnChild?: (
    command: string,
    args: string[],
    options: Parameters<typeof spawn>[2],
  ) => SpawnedChild;
  sleep?: (milliseconds: number) => Promise<void>;
}

function launchDir(root: string, runId: string): string {
  return resolve(root, ".maquila", "launches", runId);
}

export function handshakePath(root: string, runId: string): string {
  if (!UUID.test(runId)) throw new Error("invalid run ID");
  return resolve(launchDir(root, runId), "accepted.json");
}

export function terminationUnconfirmedPath(root: string, runId: string): string {
  if (!UUID.test(runId)) throw new Error("invalid run ID");
  return resolve(launchDir(root, runId), "termination-unconfirmed.json");
}

function recordTerminationUnconfirmed(
  root: string,
  runId: string,
  instanceId: string,
  pid: number | undefined,
): void {
  const value: TerminationUnconfirmed = {
    version: 1,
    runId,
    instanceId,
    pid: pid && pid > 0 ? pid : null,
    status: "termination_unconfirmed",
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(terminationUnconfirmedPath(root, runId), `${JSON.stringify(value)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}

export function readLaunchHandshake(path: string): LaunchHandshake | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 5 &&
      "version" in value &&
      value.version === 1 &&
      "runId" in value &&
      typeof value.runId === "string" &&
      UUID.test(value.runId) &&
      "instanceId" in value &&
      typeof value.instanceId === "string" &&
      UUID.test(value.instanceId) &&
      "pid" in value &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      "acceptedAt" in value &&
      typeof value.acceptedAt === "string" &&
      Number.isFinite(Date.parse(value.acceptedAt))
    )
      return {
        version: 1,
        runId: value.runId,
        instanceId: value.instanceId,
        pid: value.pid,
        acceptedAt: value.acceptedAt,
      };
  } catch {}
  return undefined;
}

export function writeLaunchHandshake(
  root: string,
  runId: string,
  instanceId: string,
  pid = process.pid,
): void {
  if (!UUID.test(runId) || !UUID.test(instanceId)) throw new Error("invalid launch identity");
  const dir = launchDir(root, runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const target = handshakePath(root, runId);
  const temporary = `${target}.${pid}.tmp`;
  const value: LaunchHandshake = {
    version: 1,
    runId,
    instanceId,
    pid,
    acceptedAt: new Date().toISOString(),
  };
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
}

async function controllerEnvironment(
  env: NodeJS.ProcessEnv,
  identity?: string,
): Promise<NodeJS.ProcessEnv> {
  const credentials = await resolveControllerCredentials({ env, identityFlag: identity });
  return controllerChildEnvironment(env, credentials);
}

function exited(child: SpawnedChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function reserveTelemetry(root: string, runId: string): string {
  const path = telemetryPath(root, runId);
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  chmodSync(resolve(path, ".."), 0o700);
  const fd = openSync(path, "wx", 0o600);
  closeSync(fd);
  return path;
}

export async function startDetachedRun(options: StartDetachedRunOptions): Promise<RunStartResult> {
  if (!options.issue.trim()) throw new Error("--issue is required");
  if (
    !Number.isInteger(options.timeoutSeconds) ||
    options.timeoutSeconds < 1 ||
    options.timeoutSeconds > 1800
  )
    throw new Error("--timeout-seconds must be an integer from 1 to 1800");
  const root = resolve(options.maquilaRoot);
  const target = (options.resolveTarget ?? resolveTargetRepository)({
    target: options.target,
    ...(options.owner ? { owner: options.owner } : {}),
    ...(options.repo ? { repo: options.repo } : {}),
    ...(options.baseRef ? { baseRef: options.baseRef } : {}),
    ...(options.tag ? { tag: options.tag } : {}),
  });
  const env = await controllerEnvironment(options.env ?? process.env, options.identity);
  const runId = options.runId ?? randomUUID();
  const instanceId = options.instanceId ?? randomUUID();
  if (!UUID.test(runId) || !UUID.test(instanceId)) throw new Error("invalid launch identity");
  const dir = launchDir(root, runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const telemetry = reserveTelemetry(root, runId);
  const stdoutPath = resolve(dir, "controller.stdout.log");
  const stderrPath = resolve(dir, "controller.stderr.log");
  const stdout = openSync(stdoutPath, "wx", 0o600);
  const stderr = openSync(stderrPath, "wx", 0o600);
  const cliPath = resolve(options.cliPath ?? process.argv[1]!);
  const childEnv = { ...env, [LAUNCH_INSTANCE_ENV]: instanceId };
  const invocation = cliInvocation(cliPath, [
    "run",
    "execute",
    "--run-id",
    runId,
    "--issue",
    options.issue,
    "--owner",
    target.owner,
    "--repo",
    target.repo,
    "--base-ref",
    target.baseRef,
    "--tag",
    target.tag,
    "--timeout-seconds",
    String(options.timeoutSeconds),
  ]);
  let child: SpawnedChild;
  try {
    child = (
      options.spawnChild ?? ((command, argv, spawnOptions) => spawn(command, argv, spawnOptions))
    )(invocation.command, invocation.args, {
      cwd: root,
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env: childEnv,
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
    options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const deadline = Date.now() + (options.startupTimeoutMs ?? 5000);
  for (;;) {
    const handshake = existsSync(handshakePath(root, runId))
      ? readLaunchHandshake(handshakePath(root, runId))
      : undefined;
    if (
      handshake?.runId === runId &&
      handshake.instanceId === instanceId &&
      handshake.pid === child.pid
    ) {
      child.unref();
      return { version: 1, accepted: true, runId, status: "running" };
    }
    if (spawnError || exited(child) || Date.now() >= deadline) {
      // Once termination starts, a racing handshake can never restore acceptance.
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
      if (!exited(child)) {
        recordTerminationUnconfirmed(root, runId, instanceId, child.pid);
        child.unref();
        throw new Error(`controller child termination unconfirmed for run ${runId}`);
      }
      child.unref();
      if (existsSync(telemetry) && readFileSync(telemetry).length === 0) rmSync(telemetry);
      throw new Error(
        spawnError ? "controller child could not start" : "controller child rejected startup",
      );
    }
    await sleep(25);
  }
}
