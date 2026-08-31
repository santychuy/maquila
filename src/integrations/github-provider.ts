import {
  type ReviewedPatchPublicationRequest,
  type SourceControlProvider,
  type SourceControlPublication,
  type SourceControlReference,
  type SourceControlSnapshot,
  validateSourceControlReference,
} from "../providers.js";
import {
  createGitHubPublicationDryRun,
  fetchGitHubSnapshot,
  publishGitHubPullRequest,
  type GitHubOptions,
  type GitHubPublication,
  type GitHubPublicationDryRun,
  type GitHubSnapshot,
} from "./github.js";
export const GITHUB_PROVIDER = "github";
function safe(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && !/[\r\n\0]/.test(value);
}
function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}
function repository(reference: SourceControlReference): { owner: string; repo: string } {
  const [owner, repo, ...rest] = reference.repository.split("/");
  if (!owner || !repo || rest.length) throw new Error("GitHub repository reference is invalid");
  return { owner, repo };
}
export interface GitHubSourceControlSnapshot extends SourceControlSnapshot {
  readonly github: GitHubSnapshot;
}
function hasGitHubSnapshot(value: SourceControlSnapshot): value is GitHubSourceControlSnapshot {
  return "github" in value && value.github !== undefined;
}
export interface GitHubSourceControlProviderOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
  fetchSnapshot?: (options: GitHubOptions) => Promise<GitHubSnapshot>;
  createPublicationDryRun?: typeof createGitHubPublicationDryRun;
  publishPullRequest?: typeof publishGitHubPullRequest;
}
/** Creates a GitHub Git/PR source-control provider. The token remains private. */
export function createGitHubSourceControlProvider(
  options: GitHubSourceControlProviderOptions,
): SourceControlProvider {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new Error("GitHub provider options must be an object");
  if (
    Object.keys(options).some(
      (key) =>
        ![
          "token",
          "fetch",
          "fetchSnapshot",
          "createPublicationDryRun",
          "publishPullRequest",
        ].includes(key),
    )
  )
    throw new Error("GitHub provider options have unknown fields");
  if (!safe(options.token)) throw new Error("GitHub token is invalid");
  return new GitHubSourceControlProvider(options);
}

export class GitHubSourceControlProvider implements SourceControlProvider {
  private readonly options: GitHubSourceControlProviderOptions;
  constructor(options: GitHubSourceControlProviderOptions) {
    this.options = options;
  }
  async fetchSourceControl(reference: unknown): Promise<GitHubSourceControlSnapshot> {
    const parsed = validateSourceControlReference(reference, GITHUB_PROVIDER);
    const { owner, repo } = repository(parsed);
    const snapshot = await (this.options.fetchSnapshot ?? fetchGitHubSnapshot)({
      token: this.options.token,
      owner,
      repo,
      baseRef: parsed.baseRef,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      !safe(snapshot.fullName) ||
      !safe(snapshot.baseRef) ||
      !/^[0-9a-f]{40}$/i.test(snapshot.baseSha) ||
      !sha256(snapshot.snapshotSha256)
    )
      throw new Error("GitHub source control is malformed");
    if (snapshot.fullName.toLowerCase() !== parsed.repository.toLowerCase())
      throw new Error("GitHub repository reference mismatch");
    if (snapshot.baseRef !== parsed.baseRef) throw new Error("GitHub base ref mismatch");
    return {
      provider: GITHUB_PROVIDER,
      repositoryId: snapshot.repositoryId,
      repository: snapshot.fullName,
      fullName: snapshot.fullName,
      baseRef: snapshot.baseRef,
      baseSha: snapshot.baseSha,
      private: snapshot.private,
      defaultBranch: snapshot.defaultBranch,
      snapshotSha256: snapshot.snapshotSha256,
      github: snapshot,
    };
  }
  cloneUrl(reference: unknown, snapshot: SourceControlSnapshot): string {
    const parsed = validateSourceControlReference(reference, GITHUB_PROVIDER);
    const { owner, repo } = repository(parsed);
    if (
      snapshot.provider !== GITHUB_PROVIDER ||
      snapshot.repository.toLowerCase() !== parsed.repository.toLowerCase() ||
      snapshot.baseRef !== parsed.baseRef ||
      !/^[0-9a-f]{40}$/i.test(snapshot.baseSha)
    )
      throw new Error("GitHub clone snapshot identity mismatch");
    if (!hasGitHubSnapshot(snapshot)) throw new Error("GitHub clone snapshot is incomplete");
    const privateRepository = snapshot.github.private;
    return `https://${privateRepository ? "github.int.exe.xyz" : "github.com"}/${owner}/${repo}.git`;
  }
  dryRunPublication(
    reference: unknown,
    request: ReviewedPatchPublicationRequest,
  ): GitHubPublicationDryRun {
    const parsed = validateSourceControlReference(reference, GITHUB_PROVIDER);
    const { owner, repo } = repository(parsed);
    return (this.options.createPublicationDryRun ?? createGitHubPublicationDryRun)({
      token: this.options.token,
      owner,
      repo,
      baseRef: parsed.baseRef,
      ...request,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
  }
  async publishReviewedPatch(
    reference: unknown,
    request: ReviewedPatchPublicationRequest,
  ): Promise<SourceControlPublication> {
    const parsed = validateSourceControlReference(reference, GITHUB_PROVIDER);
    const { owner, repo } = repository(parsed);
    const publication: GitHubPublication = await (
      this.options.publishPullRequest ?? publishGitHubPullRequest
    )({
      token: this.options.token,
      owner,
      repo,
      baseRef: parsed.baseRef,
      ...request,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    return publication;
  }
}
