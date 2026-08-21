import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";

export const controllerStates = [
  "intake",
  "creating_vm",
  "bootstrapping",
  "planning",
  "awaiting_decision",
  "implementing",
  "documenting",
  "verifying",
  "reviewing",
  "fixing",
  "ready_for_publication",
  "publishing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ControllerStateName = (typeof controllerStates)[number];
export type CleanupState = "pending" | "complete" | "not-needed" | "failed";

export interface ControllerVm {
  name: string;
  sshDest: string;
  status: string;
}

export interface ControllerState {
  version: 1;
  runId: string;
  state: ControllerStateName;
  idempotencyKey: string;
  issueUuid: string;
  issueSnapshotSha256: string;
  repositoryId: number;
  repositoryFullName: string;
  repositorySnapshotSha256: string;
  baseRef: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  vm?: ControllerVm;
  cleanup: CleanupState;
}

export type ControllerStateInput = Pick<
  ControllerState,
  | "runId"
  | "idempotencyKey"
  | "issueUuid"
  | "issueSnapshotSha256"
  | "repositoryId"
  | "repositoryFullName"
  | "repositorySnapshotSha256"
  | "baseRef"
  | "baseSha"
>;

const terminal = new Set<ControllerStateName>([
  "awaiting_decision",
  "completed",
  "failed",
  "cancelled",
]);
const retryableClaim = new Set<ControllerStateName>([
  "awaiting_decision",
  "failed",
  "cancelled",
  "ready_for_publication",
]);
const transitions: Record<ControllerStateName, ControllerStateName[]> = {
  intake: ["creating_vm", "failed", "cancelled"],
  creating_vm: ["bootstrapping", "failed", "cancelled"],
  bootstrapping: ["planning", "failed", "cancelled"],
  planning: ["awaiting_decision", "implementing", "documenting", "failed", "cancelled"],
  awaiting_decision: [],
  implementing: ["documenting", "verifying", "failed", "cancelled"],
  documenting: ["verifying", "fixing", "failed", "cancelled"],
  verifying: ["reviewing", "fixing", "failed", "cancelled"],
  reviewing: ["fixing", "ready_for_publication", "failed", "cancelled"],
  fixing: ["verifying", "failed", "cancelled"],
  ready_for_publication: ["publishing", "failed"],
  publishing: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return nonBlank(value) && Number.isFinite(Date.parse(value));
}

function isHash(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "i").test(value);
}

function isVm(value: unknown): value is ControllerVm {
  return (
    isRecord(value) &&
    exactKeys(value, ["name", "sshDest", "status"]) &&
    nonBlank(value.name) &&
    nonBlank(value.sshDest) &&
    nonBlank(value.status)
  );
}

function isControllerState(value: unknown): value is ControllerState {
  if (!isRecord(value)) return false;
  const allowed = [
    "version",
    "runId",
    "state",
    "idempotencyKey",
    "issueUuid",
    "issueSnapshotSha256",
    "repositoryId",
    "repositoryFullName",
    "repositorySnapshotSha256",
    "baseRef",
    "baseSha",
    "createdAt",
    "updatedAt",
    "cleanup",
    ...(value.vm === undefined ? [] : ["vm"]),
  ];
  if (!exactKeys(value, allowed)) return false;
  if (
    value.version !== 1 ||
    !nonBlank(value.runId) ||
    !controllerStates.some((state) => state === value.state) ||
    !isHash(value.idempotencyKey, 64) ||
    !nonBlank(value.issueUuid) ||
    !isHash(value.issueSnapshotSha256, 64) ||
    typeof value.repositoryId !== "number" ||
    !Number.isSafeInteger(value.repositoryId) ||
    value.repositoryId < 1 ||
    typeof value.repositoryFullName !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repositoryFullName) ||
    !isHash(value.repositorySnapshotSha256, 64) ||
    !nonBlank(value.baseRef) ||
    !isHash(value.baseSha, 40) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !["pending", "complete", "not-needed", "failed"].includes(String(value.cleanup)) ||
    (value.vm !== undefined && !isVm(value.vm))
  ) {
    return false;
  }
  if (value.vm === undefined && !["not-needed", "complete"].includes(String(value.cleanup)))
    return false;
  if (value.vm !== undefined && value.cleanup === "not-needed") return false;
  if (
    (value.state === "awaiting_decision" ||
      value.state === "completed" ||
      value.state === "ready_for_publication") &&
    !["complete", "not-needed"].includes(String(value.cleanup))
  ) {
    return false;
  }
  return true;
}

function statePath(runDir: string): string {
  return resolve(runDir, "controller-state.json");
}

export function readControllerState(runDir: string): ControllerState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath(runDir), "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read controller state: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isControllerState(parsed)) throw new Error("invalid controller state");
  return parsed;
}

function writeControllerState(runDir: string, state: ControllerState): void {
  if (!isControllerState(state)) throw new Error("invalid controller state");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const target = statePath(runDir);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function listStates(runsDir: string): ControllerState[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ".idempotency")
    .map((entry) => {
      const state = readControllerState(resolve(runsDir, entry.name));
      if (state.runId !== entry.name)
        throw new Error("controller state directory does not match runId");
      return state;
    });
}

function claimPath(runsDir: string, idempotencyKey: string): string {
  return resolve(runsDir, ".idempotency", idempotencyKey);
}

function releaseClaim(runsDir: string, state: ControllerState): void {
  const path = claimPath(runsDir, state.idempotencyKey);
  if (!existsSync(path)) return;
  const ownerPath = resolve(path, "run-id");
  if (existsSync(ownerPath) && readFileSync(ownerPath, "utf8").trim() !== state.runId) return;
  rmSync(path, { recursive: true, force: true });
}

function acquireClaim(runsDir: string, state: ControllerState): void {
  const claimsDir = resolve(runsDir, ".idempotency");
  const path = claimPath(runsDir, state.idempotencyKey);
  mkdirSync(claimsDir, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
    const ownerPath = resolve(path, "run-id");
    if (!existsSync(ownerPath)) {
      throw new Error("idempotency key is already claimed", { cause: error });
    }
    const owner = readFileSync(ownerPath, "utf8").trim();
    const ownerDir = resolve(runsDir, owner);
    const previous = readControllerState(ownerDir);
    if (!retryableClaim.has(previous.state)) {
      throw new Error("duplicate active or completed idempotency key", { cause: error });
    }
    releaseClaim(runsDir, previous);
    mkdirSync(path, { mode: 0o700 });
  }
  writeFileSync(resolve(path, "run-id"), `${state.runId}\n`, { flag: "wx", mode: 0o600 });
}

export function createControllerState(
  runDir: string,
  input: ControllerStateInput,
): ControllerState {
  if (basename(runDir) !== input.runId) throw new Error("run directory must match runId");
  const now = new Date().toISOString();
  const state: ControllerState = {
    version: 1,
    ...input,
    state: "intake",
    createdAt: now,
    updatedAt: now,
    cleanup: "not-needed",
  };
  if (!isControllerState(state)) throw new Error("invalid controller state input");

  const runsDir = resolve(runDir, "..");
  acquireClaim(runsDir, state);
  try {
    for (const previous of listStates(runsDir)) {
      if (previous.idempotencyKey === input.idempotencyKey && !retryableClaim.has(previous.state)) {
        throw new Error("duplicate active or completed idempotency key");
      }
    }
    writeControllerState(runDir, state);
    return state;
  } catch (error) {
    releaseClaim(runsDir, state);
    throw error;
  }
}

export function transitionControllerState(
  runDir: string,
  next: ControllerStateName,
): ControllerState {
  const current = readControllerState(runDir);
  if (!transitions[current.state].includes(next)) {
    throw new Error(`invalid transition: ${current.state} -> ${next}`);
  }
  const state = { ...current, state: next, updatedAt: new Date().toISOString() };
  writeControllerState(runDir, state);
  if (next === "awaiting_decision" || next === "failed" || next === "cancelled")
    releaseClaim(resolve(runDir, ".."), state);
  return state;
}

export function recordControllerVm(runDir: string, vm: ControllerVm): ControllerState {
  if (!isVm(vm)) throw new Error("invalid controller VM");
  const current = readControllerState(runDir);
  if (current.vm) throw new Error("controller VM already recorded");
  if (current.state !== "creating_vm") throw new Error("VM can only be recorded while creating_vm");
  const state: ControllerState = {
    ...current,
    vm,
    cleanup: "pending",
    updatedAt: new Date().toISOString(),
  };
  writeControllerState(runDir, state);
  return state;
}

export function recordControllerCleanup(runDir: string, cleanup: CleanupState): ControllerState {
  const current = readControllerState(runDir);
  if (!current.vm && cleanup !== "not-needed" && cleanup !== "complete")
    throw new Error("pending or failed cleanup requires a recorded VM");
  if (current.vm && cleanup === "not-needed") throw new Error("recorded VM requires cleanup");
  const state: ControllerState = { ...current, cleanup, updatedAt: new Date().toISOString() };
  writeControllerState(runDir, state);
  return state;
}

export function recoverStaleControllerClaims(runsDir: string): void {
  const claimsDir = resolve(runsDir, ".idempotency");
  if (!existsSync(claimsDir)) return;
  for (const entry of readdirSync(claimsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) throw new Error("invalid idempotency claim");
    const path = resolve(claimsDir, entry.name);
    const ownerPath = resolve(path, "run-id");
    if (!existsSync(ownerPath)) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    const owner = readFileSync(ownerPath, "utf8").trim();
    if (!owner || basename(owner) !== owner) throw new Error("invalid idempotency claim owner");
    const ownerDir = resolve(runsDir, owner);
    if (!existsSync(statePath(ownerDir))) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    const state = readControllerState(ownerDir);
    if (state.runId !== owner || state.idempotencyKey !== entry.name) {
      throw new Error("idempotency claim does not match controller state");
    }
    if (state.state === "failed" || state.state === "cancelled") {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

export function scanRecoverableControllerStates(runsDir: string): ControllerState[] {
  return listStates(runsDir).filter(
    (state) => !terminal.has(state.state) && state.state !== "ready_for_publication",
  );
}

export function findOrphanVms(
  runsDir: string,
): Array<{ runId: string; vm: ControllerVm; cleanup: CleanupState }> {
  return listStates(runsDir).flatMap((state) =>
    state.vm && state.cleanup !== "complete"
      ? [{ runId: state.runId, vm: state.vm, cleanup: state.cleanup }]
      : [],
  );
}
