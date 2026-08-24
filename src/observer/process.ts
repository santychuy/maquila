import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { externalCommandEnvironment } from "../integrations/exe.js";
import { linuxProcessIdentity } from "../controller-lock.js";
import { cliInvocation } from "../runtime.js";
import {
  OBSERVER_VERSION,
  record,
  UUID,
  validPort,
  type ObserverDescriptor,
  type ObserverInfo,
} from "./shared.js";
import { createObserverServer, type CreateObserverServerOptions } from "./server.js";

export type { ObserverDescriptor, ObserverInfo } from "./shared.js";

interface ObserverChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

export interface EnsureObserverOptions {
  root: string;
  cliPath: string;
  port: number;
  env?: NodeJS.ProcessEnv;
  instanceId?: string;
  startupTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  health?: (descriptor: ObserverDescriptor) => Promise<boolean>;
  live?: (pid: number) => boolean;
  identity?: (pid: number) => string | undefined;
  spawnChild?: (
    command: string,
    args: string[],
    options: Parameters<typeof spawn>[2],
  ) => ObserverChild;
}

function live(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return record(error) && error.code !== "ESRCH";
  }
}
export function observerDescriptorPath(root: string): string {
  return resolve(root, ".maquila", "observer.json");
}
function observerDir(root: string): string {
  return resolve(root, ".maquila", "observer");
}
function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
export function readObserverDescriptor(root: string): ObserverDescriptor | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(observerDescriptorPath(root), "utf8"));
    if (
      record(value) &&
      Object.keys(value).every((key) =>
        ["version", "instanceId", "pid", "processIdentity", "port", "url", "startedAt"].includes(
          key,
        ),
      ) &&
      value.version === 1 &&
      typeof value.instanceId === "string" &&
      UUID.test(value.instanceId) &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      (value.processIdentity === undefined || typeof value.processIdentity === "string") &&
      typeof value.port === "number" &&
      validPort(value.port) &&
      value.url === `http://127.0.0.1:${value.port}` &&
      typeof value.startedAt === "string" &&
      Number.isFinite(Date.parse(value.startedAt))
    )
      return {
        version: 1,
        instanceId: value.instanceId,
        pid: value.pid,
        ...(value.processIdentity ? { processIdentity: value.processIdentity } : {}),
        port: value.port,
        url: value.url,
        startedAt: value.startedAt,
      };
  } catch {}
  return undefined;
}
function writeObserverDescriptor(root: string, descriptor: ObserverDescriptor): void {
  const maquila = resolve(root, ".maquila");
  ensurePrivateDirectory(maquila);
  const target = observerDescriptorPath(root);
  const temporary = `${target}.${process.pid}.${descriptor.instanceId}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(descriptor)}\n`, { mode: 0o600, flag: "wx" });
  try {
    linkSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function removeOwnedDescriptor(root: string, instanceId: string): void {
  if (readObserverDescriptor(root)?.instanceId === instanceId)
    rmSync(observerDescriptorPath(root), { force: true });
}

export async function serveObserver(options: CreateObserverServerOptions): Promise<void> {
  const runtime = await createObserverServer(options);
  try {
    writeObserverDescriptor(options.root, runtime.descriptor);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  process.stdout.write(`Observer: ${runtime.descriptor.url}\n`);
  await new Promise<void>((done) => {
    const stop = () => runtime.close().finally(done);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  removeOwnedDescriptor(options.root, options.instanceId);
}

async function healthRequest(descriptor: ObserverDescriptor): Promise<boolean> {
  try {
    const response = await fetch(`${descriptor.url}/api/v1/health`, {
      signal: AbortSignal.timeout(1000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return false;
    const value: unknown = await response.json();
    return (
      record(value) &&
      value.version === OBSERVER_VERSION &&
      value.ok === true &&
      value.instanceId === descriptor.instanceId &&
      value.pid === descriptor.pid &&
      value.port === descriptor.port
    );
  } catch {
    return false;
  }
}

export async function ensureObserver(options: EnsureObserverOptions): Promise<ObserverInfo> {
  const root = resolve(options.root);
  const check = options.health ?? healthRequest;
  const isLive = options.live ?? live;
  const identity = options.identity ?? linuxProcessIdentity;
  const existing = readObserverDescriptor(root);
  if (existing) {
    const healthy = await check(existing);
    if (healthy) {
      if (existing.port !== options.port)
        throw new Error(`observer already running on port ${existing.port}`);
      return { ...existing, running: true };
    }
    if (
      isLive(existing.pid) &&
      (!existing.processIdentity ||
        !identity(existing.pid) ||
        existing.processIdentity === identity(existing.pid))
    )
      throw new Error("observer process is not healthy");
    rmSync(observerDescriptorPath(root), { force: true });
  } else if (existsSync(observerDescriptorPath(root))) {
    throw new Error("observer descriptor is invalid");
  }
  if (!validPort(options.port)) throw new Error("invalid observer port");
  const instanceId = options.instanceId ?? randomUUID();
  if (!UUID.test(instanceId)) throw new Error("invalid observer instance ID");
  const dir = observerDir(root);
  ensurePrivateDirectory(dir);
  const stdout = openSync(resolve(dir, "observer.stdout.log"), "a", 0o600);
  const stderr = openSync(resolve(dir, "observer.stderr.log"), "a", 0o600);
  const invocation = cliInvocation(options.cliPath, [
    "observer",
    "serve",
    "--port",
    String(options.port),
  ]);
  const child = (
    options.spawnChild ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions))
  )(invocation.command, invocation.args, {
    cwd: root,
    detached: true,
    stdio: ["ignore", stdout, stderr],
    env: {
      ...externalCommandEnvironment(options.env ?? process.env),
      MAQUILA_OBSERVER_INSTANCE_ID: instanceId,
    },
  });
  closeSync(stdout);
  closeSync(stderr);
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  const sleep =
    options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const deadline = Date.now() + (options.startupTimeoutMs ?? 5000);
  while (Date.now() < deadline) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
    const descriptor = readObserverDescriptor(root);
    if (
      descriptor?.instanceId === instanceId &&
      descriptor.pid === child.pid &&
      (await check(descriptor))
    ) {
      child.unref();
      return { ...descriptor, running: true };
    }
    await sleep(25);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const terminateBy = Date.now() + 1000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < terminateBy)
      await sleep(25);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const killBy = Date.now() + 1000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < killBy)
      await sleep(25);
  }
  child.unref();
  if (child.exitCode === null && child.signalCode === null)
    throw new Error("observer termination unconfirmed");
  removeOwnedDescriptor(root, instanceId);
  throw new Error(spawnError ? "observer could not start" : "observer failed readiness check");
}

export async function observerStatus(root: string): Promise<ObserverInfo | undefined> {
  const descriptor = readObserverDescriptor(root);
  return descriptor && (await healthRequest(descriptor))
    ? { ...descriptor, running: true }
    : undefined;
}

export async function stopObserver(
  root: string,
  runtime: {
    health?: (descriptor: ObserverDescriptor) => Promise<boolean>;
    identity?: (pid: number) => string | undefined;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<ObserverDescriptor> {
  const descriptor = readObserverDescriptor(root);
  if (!descriptor) throw new Error("observer is not running");
  if (!(await (runtime.health ?? healthRequest)(descriptor)))
    throw new Error("observer ownership could not be proven");
  const currentIdentity = (runtime.identity ?? linuxProcessIdentity)(descriptor.pid);
  if (
    descriptor.processIdentity &&
    (!currentIdentity || currentIdentity !== descriptor.processIdentity)
  )
    throw new Error("observer ownership could not be proven");
  (runtime.kill ?? ((pid, signal) => process.kill(pid, signal)))(descriptor.pid, "SIGTERM");
  const sleep =
    runtime.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!existsSync(observerDescriptorPath(root))) return descriptor;
    await sleep(25);
  }
  throw new Error("observer did not stop");
}
