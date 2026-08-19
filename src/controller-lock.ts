import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

interface Owner {
  token: string;
  pid: number;
  startedAt: string;
  processIdentity?: string;
}

export interface ControllerLockRuntime {
  pid: number;
  live(pid: number): boolean;
  identity(pid: number): string | undefined;
  now?(): number;
  /** Test seam invoked after opening the guard owner but before writing it. */
  onGuardOwnerOpened?(): void;
  /** Test seam invoked while the acquisition guard is still held. */
  onOwnerWritten?(): void;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function errno(error: unknown): string | undefined {
  return record(error) && typeof error.code === "string" ? error.code : undefined;
}
function parseOwner(path: string): Owner | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      record(value) &&
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.startedAt === "string" &&
      Number.isFinite(Date.parse(value.startedAt)) &&
      (value.processIdentity === undefined || typeof value.processIdentity === "string")
    )
      return {
        token: value.token,
        pid: value.pid,
        startedAt: value.startedAt,
        ...(value.processIdentity ? { processIdentity: value.processIdentity } : {}),
      };
  } catch {}
  return undefined;
}
function live(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) !== "ESRCH";
  }
}

/** Stable process birth identity on supported host platforms. */
export function linuxProcessIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (process.platform === "darwin") {
      const startedAt = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return startedAt ? `darwin:${startedAt}` : undefined;
    }
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (!bootId || close < 0) return undefined;
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    const startTime = fields[19]; // field 22; fields starts at proc field 3.
    return startTime ? `${bootId}:${startTime}` : undefined;
  } catch {
    return undefined;
  }
}

function defaultRuntime(): ControllerLockRuntime {
  return { pid: process.pid, live, identity: linuxProcessIdentity };
}

export interface ControllerLock {
  release(): void;
}
export function acquireControllerLock(
  root: string,
  runtime: ControllerLockRuntime = defaultRuntime(),
): ControllerLock {
  if (!Number.isSafeInteger(runtime.pid) || runtime.pid < 1)
    throw new Error("invalid controller PID");
  const factoryDir = resolve(root, ".factory");
  const path = resolve(factoryDir, "controller.lock");
  const guard = resolve(factoryDir, "controller.lock.acquire");
  mkdirSync(factoryDir, { recursive: true, mode: 0o700 });
  chmodSync(factoryDir, 0o700);
  let guardToken: string | undefined;
  try {
    mkdirSync(guard, { mode: 0o700 });
    const identity = runtime.identity(runtime.pid);
    const guardOwner: Owner = {
      token: randomUUID(),
      pid: runtime.pid,
      startedAt: new Date().toISOString(),
      ...(identity ? { processIdentity: identity } : {}),
    };
    guardToken = guardOwner.token;
    const guardPath = resolve(guard, "owner.json");
    const guardFd = openSync(guardPath, "wx", 0o600);
    try {
      runtime.onGuardOwnerOpened?.();
      writeFileSync(guardFd, JSON.stringify(guardOwner));
      fsyncSync(guardFd);
    } finally {
      closeSync(guardFd);
    }
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
    const guardOwner = parseOwner(resolve(guard, "owner.json"));
    if (!guardOwner) {
      // A contender can observe the directory between mkdir and owner fsync.
      // Only reclaim an ownerless/corrupt guard after that synchronous window.
      let stale = false;
      try {
        stale = (runtime.now?.() ?? Date.now()) - statSync(guard).mtimeMs > 30_000;
      } catch {}
      if (!stale) throw new Error("controller lock is held", { cause: error });
    } else if (!guardOwner.processIdentity) {
      // Legacy/unsupported identity cannot distinguish PID reuse, but a dead
      // owner is still safe to reclaim.
      if (runtime.live(guardOwner.pid))
        throw new Error("controller lock is held", { cause: error });
    } else if (runtime.live(guardOwner.pid)) {
      const identity = runtime.identity(guardOwner.pid);
      // Cannot prove reuse when identity is unavailable.
      if (!identity || identity === guardOwner.processIdentity)
        throw new Error("controller lock is held", { cause: error });
    }
    rmSync(guard, { recursive: true, force: true });
    return acquireControllerLock(root, runtime);
  }
  if (!guardToken || parseOwner(resolve(guard, "owner.json"))?.token !== guardToken)
    throw new Error("controller lock guard ownership lost");
  try {
    const current = parseOwner(path);
    if (current) {
      if (runtime.live(current.pid)) {
        const identity = runtime.identity(current.pid);
        // Old/unsupported identity cannot safely prove PID reuse.
        if (!current.processIdentity || !identity || current.processIdentity === identity)
          throw new Error("controller lock is held");
      }
      rmSync(path, { force: true });
    } else {
      try {
        readFileSync(path);
        throw new Error("controller lock is held");
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
    }

    const processIdentity = runtime.identity(runtime.pid);
    const owner: Owner = {
      token: randomUUID(),
      pid: runtime.pid,
      startedAt: new Date().toISOString(),
      ...(processIdentity ? { processIdentity } : {}),
    };
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(owner));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    runtime.onOwnerWritten?.();
    return {
      release() {
        if (parseOwner(path)?.token === owner.token) rmSync(path, { force: true });
      },
    };
  } finally {
    if (parseOwner(resolve(guard, "owner.json"))?.token === guardToken)
      rmSync(guard, { recursive: true, force: true });
  }
}
