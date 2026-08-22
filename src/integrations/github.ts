import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { externalCommandEnvironment } from "./exe.js";

const execFileAsync = promisify(execFile);

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

export interface GitHubPublication {
  number: number;
  url: string;
  branch: string;
  commitSha: string;
}

export interface GitHubPublicationOptions {
  fetch?: typeof globalThis.fetch;
  runGit?: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;
  token: string;
  owner: string;
  repo: string;
  baseRef: string;
  baseSha: string;
  runId: string;
  idempotencyKey: string;
  issueIdentifier: string;
  issueTitle: string;
  issueUrl: string;
  patchPath: string;
  patchSha256: string;
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

async function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    return (
      await execFileAsync("git", args, {
        cwd,
        env,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw new Error("GitHub publication Git command failed");
  }
}

async function request(
  fetcher: typeof fetch,
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("accept", "application/vnd.github+json");
    headers.set("content-type", "application/json");
    headers.set("x-github-api-version", "2022-11-28");
    return await fetcher(url, { ...init, headers });
  } catch {
    throw new Error("GitHub publication request failed");
  }
}

async function responseJson(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} response is malformed`);
  }
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

function publication(
  value: unknown,
  owner: string,
  repo: string,
  branch: string,
): GitHubPublication {
  const pull = record(value, "GitHub pull request");
  const number = pull.number;
  const url = pull.html_url;
  const head = record(pull.head, "GitHub pull request head");
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    url !== `https://github.com/${owner}/${repo}/pull/${number}` ||
    pull.state !== "open" ||
    pull.draft !== false ||
    typeof head.sha !== "string" ||
    !/^[0-9a-f]{40}$/i.test(head.sha)
  ) {
    throw new Error("GitHub pull request response is malformed");
  }
  return { number, url, branch, commitSha: head.sha };
}

export async function publishGitHubPullRequest(
  options: GitHubPublicationOptions,
): Promise<GitHubPublication> {
  const token = text(options.token, "GitHub token");
  const owner = text(options.owner, "owner");
  const repo = text(options.repo, "repo");
  const baseRef = text(options.baseRef, "baseRef");
  const baseSha = text(options.baseSha, "baseSha");
  const runId = text(options.runId, "runId");
  const idempotencyKey = text(options.idempotencyKey, "idempotencyKey");
  const issueIdentifier = text(options.issueIdentifier, "issueIdentifier");
  const issueTitle = text(options.issueTitle, "issueTitle").replaceAll(/\s+/g, " ").slice(0, 200);
  const issueUrl = text(options.issueUrl, "issueUrl");
  const patchPath = resolve(text(options.patchPath, "patchPath"));
  const patchSha256 = text(options.patchSha256, "patchSha256");
  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repo) ||
    !validBaseRef(baseRef) ||
    !/^[0-9a-f]{40}$/i.test(baseSha) ||
    !/^[0-9a-f]{64}$/i.test(idempotencyKey) ||
    !/^[0-9a-f]{64}$/i.test(patchSha256) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId) ||
    !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(issueIdentifier) ||
    !issueUrl.startsWith("https://linear.app/")
  ) {
    throw new Error("invalid GitHub publication input");
  }

  const branch = `maquila/${issueIdentifier.toLowerCase()}-${idempotencyKey.slice(0, 12)}`;
  const directory = mkdtempSync(join(tmpdir(), "maquila-publish-"));
  chmodSync(directory, 0o700);
  const askpass = join(directory, "askpass.sh");
  writeFileSync(
    askpass,
    '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" x-access-token ;;\n  *) printf "%s\\n" "$MAQUILA_GITHUB_TOKEN" ;;\nesac\n',
    { mode: 0o700 },
  );
  const env = {
    ...externalCommandEnvironment(),
    MAQUILA_GITHUB_TOKEN: token,
    GIT_ASKPASS: askpass,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const runner = options.runGit ?? runGit;
  const git = (args: string[]) =>
    runner(["-c", "core.hooksPath=/dev/null", ...args], directory, env);
  const fetcher = options.fetch ?? fetch;

  try {
    await git(["init", "--quiet"]);
    await git(["remote", "add", "origin", `https://github.com/${owner}/${repo}.git`]);
    await git(["fetch", "--quiet", "--no-tags", "--depth=1", "origin", `refs/heads/${baseRef}`]);
    await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    const fetchedSha = (await git(["rev-parse", "HEAD"])).trim();
    if (fetchedSha !== baseSha) throw new Error("GitHub base branch moved before publication");
    await git(["apply", "--check", "--index", "--", patchPath]);
    await git(["apply", "--index", "--", patchPath]);
    const commitDate = (await git(["show", "-s", "--format=%cI", "HEAD"])).trim();
    if (!Number.isFinite(Date.parse(commitDate)))
      throw new Error("Git base commit date is invalid");
    const commitEnv = {
      ...env,
      GIT_AUTHOR_DATE: commitDate,
      GIT_AUTHOR_EMAIL: "maquila@users.noreply.github.com",
      GIT_AUTHOR_NAME: "Maquila",
      GIT_COMMITTER_DATE: commitDate,
      GIT_COMMITTER_EMAIL: "maquila@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Maquila",
    };
    await runner(
      [
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "--no-verify",
        "-m",
        `${issueIdentifier}: ${issueTitle}`,
      ],
      directory,
      commitEnv,
    );
    const commitSha = (await git(["rev-parse", "HEAD"])).trim();
    if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error("Git publication commit is invalid");

    const refResponse = await request(
      fetcher,
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${encodeURIComponent(`heads/${branch}`)}`,
      token,
    );
    if (refResponse.status === 200) {
      const ref = record(await responseJson(refResponse, "GitHub ref"), "GitHub ref");
      const object = record(ref.object, "GitHub ref object");
      if (ref.ref !== `refs/heads/${branch}` || object.sha !== commitSha) {
        throw new Error("GitHub publication branch already exists with different content");
      }
    } else if (refResponse.status === 404) {
      await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
    } else {
      throw new Error(`GitHub publication failed (${refResponse.status})`);
    }

    const query = new URLSearchParams({
      state: "all",
      head: `${owner}:${branch}`,
      base: baseRef,
      per_page: "2",
    });
    const pullsResponse = await request(
      fetcher,
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query}`,
      token,
    );
    if (!pullsResponse.ok) throw new Error(`GitHub publication failed (${pullsResponse.status})`);
    const existing = await responseJson(pullsResponse, "GitHub pull request list");
    if (!Array.isArray(existing)) throw new Error("GitHub pull request list is malformed");
    if (existing.length > 1) throw new Error("multiple GitHub pull requests match publication");
    if (existing.length === 1) {
      const result = publication(existing[0], owner, repo, branch);
      if (result.commitSha !== commitSha)
        throw new Error("GitHub pull request has unexpected content");
      return result;
    }

    const createResponse = await request(
      fetcher,
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          title: `[${issueIdentifier}] ${issueTitle}`,
          head: branch,
          base: baseRef,
          draft: false,
          body: [
            `Automated proposal for [${issueIdentifier}](${issueUrl}).`,
            "",
            `Maquila run: \`${runId}\``,
            `Pinned base: \`${baseSha}\``,
            `Reviewed patch SHA-256: \`${patchSha256}\``,
            "",
            "Deterministic verification and independent review passed. Human review and merge remain required.",
          ].join("\n"),
        }),
      },
    );
    if (createResponse.status !== 201)
      throw new Error(`GitHub publication failed (${createResponse.status})`);
    const result = publication(
      await responseJson(createResponse, "GitHub pull request"),
      owner,
      repo,
      branch,
    );
    if (result.commitSha !== commitSha)
      throw new Error("GitHub pull request has unexpected content");
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
