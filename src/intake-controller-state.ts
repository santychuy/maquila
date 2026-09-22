import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertExeVmName } from "./integrations/exe.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{40,120}={0,3}(?: [A-Za-z0-9._:@+-]{1,128})?$/;
const STATUSES = new Set(["provisioning", "running", "cleanup_pending", "destroyed"]);

export interface IntakeControllerState {
  version: 1;
  deploymentId: string;
  status: "provisioning" | "running" | "cleanup_pending" | "destroyed";
  vmName: string;
  sshDest: string;
  publicUrl: string;
  port: number;
  targetFullName: string;
  targetBaseRef: string;
  sourceSha: string;
  sourceDirty: boolean;
  packageSha256: string;
  bootPersistent: boolean;
  controllerPublicKey?: string;
  linearWebhookId?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function valid(value: unknown): value is IntakeControllerState {
  if (!record(value)) return false;
  const allowed = [
    "version",
    "deploymentId",
    "status",
    "vmName",
    "sshDest",
    "publicUrl",
    "port",
    "targetFullName",
    "targetBaseRef",
    "sourceSha",
    "sourceDirty",
    "packageSha256",
    "bootPersistent",
    "controllerPublicKey",
    "linearWebhookId",
    "expiresAt",
    "createdAt",
    "updatedAt",
  ];
  if (!Object.keys(value).every((key) => allowed.includes(key)) || value.version !== 1)
    return false;
  try {
    assertExeVmName(value.vmName);
  } catch {
    return false;
  }
  let publicUrl: URL;
  try {
    publicUrl = new URL(String(value.publicUrl));
  } catch {
    return false;
  }
  return (
    typeof value.deploymentId === "string" &&
    UUID.test(value.deploymentId) &&
    typeof value.status === "string" &&
    STATUSES.has(value.status) &&
    typeof value.sshDest === "string" &&
    /^[A-Za-z0-9.-]+$/.test(value.sshDest) &&
    publicUrl.protocol === "https:" &&
    publicUrl.origin === publicUrl.href.replace(/\/$/, "") &&
    Number.isInteger(value.port) &&
    Number(value.port) >= 1 &&
    Number(value.port) <= 65_535 &&
    typeof value.targetFullName === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.targetFullName) &&
    typeof value.targetBaseRef === "string" &&
    value.targetBaseRef.length > 0 &&
    value.targetBaseRef.length <= 255 &&
    !Array.from(value.targetBaseRef).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    typeof value.sourceSha === "string" &&
    SHA.test(value.sourceSha) &&
    typeof value.sourceDirty === "boolean" &&
    typeof value.packageSha256 === "string" &&
    SHA256.test(value.packageSha256) &&
    typeof value.bootPersistent === "boolean" &&
    (value.controllerPublicKey === undefined ||
      (typeof value.controllerPublicKey === "string" &&
        PUBLIC_KEY.test(value.controllerPublicKey))) &&
    (value.linearWebhookId === undefined ||
      (typeof value.linearWebhookId === "string" && UUID.test(value.linearWebhookId))) &&
    validTimestamp(value.createdAt) &&
    (value.expiresAt === undefined ||
      (validTimestamp(value.expiresAt) &&
        Date.parse(value.expiresAt) > Date.parse(value.createdAt))) &&
    validTimestamp(value.updatedAt)
  );
}

function errorCode(value: unknown): string | undefined {
  return record(value) && typeof value.code === "string" ? value.code : undefined;
}

export function intakeControllerStatePath(stateRoot: string): string {
  return resolve(stateRoot, "intake-controller.json");
}

export function readIntakeControllerState(path: string): IntakeControllerState | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!valid(value)) throw new Error("intake controller state malformed");
    return value;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

export function writeIntakeControllerState(path: string, state: IntakeControllerState): void {
  if (!valid(state)) throw new Error("intake controller state malformed");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
