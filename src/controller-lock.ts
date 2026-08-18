import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

interface Owner {
  token: string;
  pid: number;
  startedAt: string;
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
      typeof value.startedAt === "string"
    )
      return { token: value.token, pid: value.pid, startedAt: value.startedAt };
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
export interface ControllerLock {
  release(): void;
}
export function acquireControllerLock(root: string): ControllerLock {
  const path = resolve(root, ".factory", "controller.lock");
  mkdirSync(resolve(root, ".factory"), { recursive: true });
  const owner: Owner = {
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(owner));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return {
        release() {
          if (parseOwner(path)?.token === owner.token) rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      const current = parseOwner(path);
      if (!current || live(current.pid))
        throw new Error("controller lock is held", { cause: error });
      rmSync(path, { force: true });
    }
  }
  throw new Error("controller lock is held");
}
