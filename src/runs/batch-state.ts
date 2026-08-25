import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { validateResolvedTarget } from "../target.js";

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

export function writeBatchState(root: string, state: BatchState): void {
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
