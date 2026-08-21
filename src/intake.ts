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
export interface Intake {
  issue: LinearSnapshot;
  repository: GitHubSnapshot;
  idempotencyKey: string;
}
export async function createIntake(
  linear: Omit<LinearOptions, "issue"> & { issue: string },
  github: GitHubOptions,
): Promise<Intake> {
  const [issue, repository] = await Promise.all([
    fetchLinearIssue(linear),
    fetchGitHubSnapshot(github),
  ]);
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
