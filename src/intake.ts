import { createHash } from "node:crypto";
import {
  fetchLinearIssue,
  type LinearOptions,
  type LinearSnapshot,
} from "./integrations/linear.js";
import {
  fetchGitHubSnapshot,
  type GitHubOptions,
  type GitHubSnapshot,
} from "./integrations/github.js";
import type {
  SourceControlProvider,
  SourceControlSnapshot,
  WorkItemProvider,
  WorkItemSnapshot,
} from "./providers.js";

/** Legacy built-in intake evidence. Keep this shape for CLI artifact compatibility. */
export interface Intake {
  issue: LinearSnapshot;
  repository: GitHubSnapshot;
  idempotencyKey: string;
}
/** Provider-backed intake. `native` is optional compatibility evidence, never credentials. */
export interface ProviderIntake {
  workItem: WorkItemSnapshot;
  sourceControl: SourceControlSnapshot;
  idempotencyKey: string;
  native?: Intake;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value))
    throw new Error(`${label} digest is invalid`);
  return value;
}
function hasLinearSnapshot(
  value: WorkItemSnapshot,
): value is WorkItemSnapshot & { linear: LinearSnapshot } {
  return "linear" in value && value.linear !== undefined;
}
function hasGitHubSnapshot(
  value: SourceControlSnapshot,
): value is SourceControlSnapshot & { github: GitHubSnapshot } {
  return "github" in value && value.github !== undefined;
}
function providerIntakeKey(
  workItem: WorkItemSnapshot,
  sourceControl: SourceControlSnapshot,
): string {
  // Git/Linear retains its historic key below. Other providers bind their canonical identity.
  return createHash("sha256")
    .update(
      JSON.stringify({
        workItemId: workItem.id,
        repositoryId: sourceControl.repositoryId,
        baseRef: sourceControl.baseRef,
        baseSha: sourceControl.baseSha,
      }),
    )
    .digest("hex");
}
export async function createProviderIntake(input: {
  workItemProvider: WorkItemProvider;
  workItemReference: unknown;
  sourceControlProvider: SourceControlProvider;
  sourceControlReference: unknown;
}): Promise<ProviderIntake> {
  const [workItem, sourceControl] = await Promise.all([
    input.workItemProvider.fetchWorkItem(input.workItemReference),
    input.sourceControlProvider.fetchSourceControl(input.sourceControlReference),
  ]);
  if (
    !workItem ||
    !sourceControl ||
    !workItem.id ||
    !workItem.key ||
    !workItem.title ||
    !workItem.body ||
    !workItem.url ||
    !Number.isSafeInteger(sourceControl.repositoryId) ||
    sourceControl.repositoryId <= 0 ||
    !sourceControl.repository ||
    !sourceControl.fullName ||
    !sourceControl.baseRef ||
    typeof sourceControl.private !== "boolean" ||
    !sourceControl.defaultBranch ||
    !/^[0-9a-f]{40}$/i.test(sourceControl.baseSha)
  )
    throw new Error("provider intake facts are malformed");
  digest(workItem.snapshotSha256, "work item snapshot");
  digest(sourceControl.snapshotSha256, "source-control snapshot");
  const native =
    hasLinearSnapshot(workItem) && hasGitHubSnapshot(sourceControl)
      ? createIntakeFromSnapshots(workItem.linear, sourceControl.github)
      : undefined;
  return {
    workItem,
    sourceControl,
    idempotencyKey: native?.idempotencyKey ?? providerIntakeKey(workItem, sourceControl),
    ...(native ? { native } : {}),
  };
}
export function createIntakeFromSnapshots(
  issue: LinearSnapshot,
  repository: GitHubSnapshot,
): Intake {
  const input = {
    issueUuid: issue.uuid,
    repositoryId: repository.repositoryId,
    baseRef: repository.baseRef,
    baseSha: repository.baseSha,
  };
  return {
    issue,
    repository,
    idempotencyKey: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
  };
}
export async function createIntake(
  linear: Omit<LinearOptions, "issue"> & { issue: string },
  github: GitHubOptions,
): Promise<Intake> {
  const [issue, repository] = await Promise.all([
    fetchLinearIssue(linear),
    fetchGitHubSnapshot(github),
  ]);
  return createIntakeFromSnapshots(issue, repository);
}

/** Convert historic Linear/GitHub intake into the canonical controller facts. */
export function providerIntakeFromLegacy(native: Intake): ProviderIntake {
  return {
    workItem: {
      provider: "linear",
      id: native.issue.uuid,
      key: native.issue.identifier,
      title: native.issue.title,
      body: native.issue.description,
      url: native.issue.url,
      snapshotSha256: native.issue.snapshotSha256,
      decisionPrincipal: native.issue.assignee,
    },
    sourceControl: {
      provider: "github",
      repositoryId: native.repository.repositoryId,
      repository: native.repository.fullName,
      fullName: native.repository.fullName,
      baseRef: native.repository.baseRef,
      baseSha: native.repository.baseSha,
      private: native.repository.private,
      defaultBranch: native.repository.defaultBranch,
      snapshotSha256: native.repository.snapshotSha256,
    },
    idempotencyKey: native.idempotencyKey,
    native,
  };
}
