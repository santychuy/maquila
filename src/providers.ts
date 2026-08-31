/** Strict provider ports. Constructors retain credentials; public values never carry them. */

import type { TelemetryRecord } from "./telemetry.js";

export interface ProviderReference {
  provider: string;
}
export interface WorkItemReference extends ProviderReference {
  id: string;
}
export interface SourceControlReference extends ProviderReference {
  repository: string;
  baseRef: string;
}
export interface ExecutionReference extends ProviderReference {
  /** Built-in execution tags are non-secret per-run routing facts. */
  tag?: string;
}
export interface DecisionPrincipal {
  id: string;
  name: string;
  url: string;
}

/** Provider-neutral facts consumed by controller code. */
export interface WorkItemSnapshot {
  provider: string;
  id: string;
  key: string;
  title: string;
  body: string;
  url: string;
  snapshotSha256: string;
  decisionPrincipal?: DecisionPrincipal;
}
export interface SourceControlSnapshot {
  provider: string;
  /** Canonical Git/PR facts required by controller state v2. */
  repositoryId: number;
  repository: string;
  fullName: string;
  baseRef: string;
  baseSha: string;
  private: boolean;
  defaultBranch: string;
  snapshotSha256: string;
}
export interface ExecutionVm {
  name: string;
  status: string;
  destination: string;
}
export interface ExecutionResult {
  stdout: string;
  stderr: string;
}

/** A controller request. Provider-specific durable evidence may extend this receipt. */
export interface DecisionRequest {
  workItem: WorkItemSnapshot;
  principal: DecisionPrincipal;
  runId: string;
  decisions: string[];
  generation?: number;
  requestedAt?: string;
}
export interface DecisionReceipt {
  /** Provider identity and durable, non-secret decision-thread facts. */
  provider: string;
  commentId: string;
  commentUrl: string;
  workItemId: string;
  principalId: string;
  generation: number;
  questionSha256: string;
  questionCount: number;
  requestedAt: string;
  marker: string;
}
export interface DecisionReply {
  commentId: string;
  body: string;
  createdAt: string;
  sha256: string;
}

export interface WorkItemProvider {
  fetchWorkItem(reference: unknown): Promise<WorkItemSnapshot>;
  requestDecision(reference: unknown, request: DecisionRequest): Promise<DecisionReceipt>;
  waitForDecision(reference: unknown, receipt: DecisionReceipt): Promise<DecisionReply | undefined>;
}

export interface ReviewedPatchPublicationRequest {
  runId: string;
  idempotencyKey: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string;
  patchPath: string;
  patchSha256: string;
  baseSha: string;
}
export interface PublicationDryRun {
  version: 1;
  mode: "dry-run";
  repository: string;
  baseRef: string;
  baseSha: string;
  runId: string;
  idempotencyKey: string;
  issueIdentifier: string;
  proposedBranch: string;
  patchSha256: string;
}
export interface SourceControlPublication {
  number: number;
  url: string;
  branch: string;
  commitSha: string;
}
export interface SourceControlProvider {
  fetchSourceControl(reference: unknown): Promise<SourceControlSnapshot>;
  /** Git/PR-oriented in Phase 1 because controller state v2 persists Git base facts. */
  cloneUrl(reference: unknown, snapshot: SourceControlSnapshot): string;
  dryRunPublication(
    reference: unknown,
    request: ReviewedPatchPublicationRequest,
  ): PublicationDryRun;
  publishReviewedPatch(
    reference: unknown,
    request: ReviewedPatchPublicationRequest,
  ): Promise<SourceControlPublication>;
}
export interface ExecutionProvider {
  createVm(
    reference: unknown,
    options: { name: string; tag: string; integration?: string },
  ): Promise<ExecutionVm>;
  destroyVm(reference: unknown, name: string): Promise<{ destroyed: boolean; notFound: boolean }>;
  exec(
    reference: unknown,
    destination: string,
    argv: string[],
    timeoutMs?: number,
  ): Promise<ExecutionResult>;
  execStream(
    reference: unknown,
    destination: string,
    argv: string[],
    onStdout: (chunk: Buffer) => void,
    timeoutMs?: number,
  ): Promise<{ stderr: string }>;
  copyTo(
    reference: unknown,
    destination: string,
    localPath: string,
    remotePath: string,
  ): Promise<ExecutionResult>;
  copyFrom(
    reference: unknown,
    destination: string,
    remotePath: string,
    localPath: string,
  ): Promise<ExecutionResult>;
}
/** Best-effort observer hook. It has no controller authority. */
export interface EventSink {
  emit(event: TelemetryRecord): void | Promise<void>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value));
}
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const result = record(value, label);
  if (Object.keys(result).some((key) => !keys.includes(key)))
    throw new Error(`${label} has unknown fields`);
  return result;
}
export function safeProviderString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)).some(
      (code) => code < 32 || code === 127,
    )
  )
    throw new Error(`${label} must be a safe non-blank string`);
  return value;
}
export function validateWorkItemReference(value: unknown, provider: string): WorkItemReference {
  const result = exact(value, ["provider", "id"], "work-item provider reference");
  if (safeProviderString(result.provider, "provider") !== provider)
    throw new Error("work-item provider mismatch");
  return { provider, id: safeProviderString(result.id, "work-item ID") };
}
export function validateSourceControlReference(
  value: unknown,
  provider: string,
): SourceControlReference {
  const result = exact(
    value,
    ["provider", "repository", "baseRef"],
    "source-control provider reference",
  );
  if (safeProviderString(result.provider, "provider") !== provider)
    throw new Error("source-control provider mismatch");
  return {
    provider,
    repository: safeProviderString(result.repository, "repository"),
    baseRef: safeProviderString(result.baseRef, "base ref"),
  };
}
export function validateExecutionReference(value: unknown, provider: string): ExecutionReference {
  const result = exact(value, ["provider", "tag"], "execution provider reference");
  if (safeProviderString(result.provider, "provider") !== provider)
    throw new Error("execution provider mismatch");
  return {
    provider,
    ...(result.tag === undefined ? {} : { tag: safeProviderString(result.tag, "execution tag") }),
  };
}
