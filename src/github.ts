import { createHash } from "node:crypto";

const GITHUB_API = "https://api.github.com";

export interface GitHubSnapshot {
  repositoryId: number;
  fullName: string;
  baseRef: string;
  baseSha: string;
  private: boolean;
  defaultBranch: string;
  snapshotSha256: string;
}

export interface GitHubOptions {
  fetch?: typeof globalThis.fetch;
  token: string;
  owner: string;
  repo: string;
  baseRef: string;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-blank`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is malformed`);
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validBaseRef(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.includes("/.") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

async function get(fetcher: typeof fetch, url: string, token: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
  } catch {
    throw new Error("GitHub request failed");
  }
  if (!response.ok) throw new Error(`GitHub HTTP request failed (${response.status})`);
  try {
    return await response.json();
  } catch {
    throw new Error("GitHub response is malformed");
  }
}

export async function fetchGitHubSnapshot(options: GitHubOptions): Promise<GitHubSnapshot> {
  text(options.token, "GitHub token");
  const owner = text(options.owner, "owner");
  const repo = text(options.repo, "repo");
  const baseRef = text(options.baseRef, "baseRef");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("invalid GitHub repository");
  }
  if (!validBaseRef(baseRef)) throw new Error("invalid GitHub base ref");

  const fetcher = options.fetch ?? fetch;
  const requestedFullName = `${owner}/${repo}`;
  const repository = record(
    await get(
      fetcher,
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      options.token,
    ),
    "GitHub repository response",
  );
  const fullName = text(repository.full_name, "full_name");
  if (fullName.toLowerCase() !== requestedFullName.toLowerCase()) {
    throw new Error("GitHub repository mismatch");
  }

  const ref = record(
    await get(
      fetcher,
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${encodeURIComponent(`heads/${baseRef}`)}`,
      options.token,
    ),
    "GitHub ref response",
  );
  if (ref.ref !== `refs/heads/${baseRef}`) throw new Error("GitHub ref mismatch");
  const object = record(ref.object, "GitHub ref object");
  const baseSha = object.sha;
  if (typeof baseSha !== "string" || !/^[0-9a-f]{40}$/i.test(baseSha) || object.type !== "commit") {
    throw new Error("GitHub ref is not a commit SHA");
  }
  if (
    typeof repository.id !== "number" ||
    !Number.isSafeInteger(repository.id) ||
    repository.id < 1 ||
    typeof repository.private !== "boolean"
  ) {
    throw new Error("GitHub repository response is malformed");
  }
  const defaultBranch = text(repository.default_branch, "default_branch");
  const snapshot = {
    repositoryId: repository.id,
    fullName,
    baseRef,
    baseSha,
    private: repository.private,
    defaultBranch,
  };
  return { ...snapshot, snapshotSha256: hash(snapshot) };
}
