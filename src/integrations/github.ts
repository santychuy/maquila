import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
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
  visualEvidence?: {
    screenshots: number;
    video: "attached" | "skipped" | "failed";
    warning?: string;
  };
}

export interface GitHubVisualEvidence {
  summary: string;
  screenshots: Array<{ path: string; alt: string }>;
  video?: string;
}

export interface GitHubPublicationOptions {
  fetch?: typeof globalThis.fetch;
  runGit?: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;
  runGh?: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;
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
  visualEvidence?: GitHubVisualEvidence;
}

export interface GitHubPublicationDryRun {
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

async function runGh(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    return (
      await execFileAsync("gh", args, {
        cwd,
        env,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw new Error("GitHub visual evidence attachment failed");
  }
}

function visualEvidence(value: GitHubVisualEvidence | undefined): GitHubVisualEvidence | undefined {
  if (!value) return undefined;
  const summary = text(value.summary, "visual evidence summary");
  if (summary.length > 500 || /[\r\n\0]/.test(summary))
    throw new Error("invalid visual evidence summary");
  if (value.screenshots.length < 2 || value.screenshots.length > 10)
    throw new Error("visual evidence requires 2-10 screenshots");
  const screenshots = value.screenshots.map((item) => {
    const path = resolve(text(item.path, "visual evidence screenshot"));
    const alt = text(item.alt, "visual evidence alt text");
    if (
      !/^ui-[a-z0-9][a-z0-9-]{0,80}\.png$/.test(basename(path)) ||
      alt.length > 125 ||
      /[\r\n\0#]/.test(alt)
    )
      throw new Error("invalid visual evidence screenshot");
    if (!existsSync(path) || !statSync(path).isFile())
      throw new Error("visual evidence screenshot is missing");
    return { path, alt };
  });
  const video = value.video ? resolve(text(value.video, "visual evidence video")) : undefined;
  if (
    video &&
    (!/^ui-[a-z0-9][a-z0-9-]{0,80}\.(?:mp4|webm)$/.test(basename(video)) ||
      !existsSync(video) ||
      !statSync(video).isFile())
  )
    throw new Error("invalid visual evidence video");
  return { summary, screenshots, ...(video ? { video } : {}) };
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
  allowDraft = false,
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
    typeof pull.draft !== "boolean" ||
    (!allowDraft && pull.draft) ||
    typeof head.sha !== "string" ||
    !/^[0-9a-f]{40}$/i.test(head.sha)
  ) {
    throw new Error("GitHub pull request response is malformed");
  }
  return { number, url, branch, commitSha: head.sha };
}

function validateGitHubPublication(options: GitHubPublicationOptions) {
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
  let parsedIssueUrl: URL;
  try {
    parsedIssueUrl = new URL(issueUrl);
  } catch {
    throw new Error("invalid GitHub publication input");
  }
  const patchPath = resolve(text(options.patchPath, "patchPath"));
  const patchSha256 = text(options.patchSha256, "patchSha256");
  const evidence = visualEvidence(options.visualEvidence);
  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repo) ||
    !validBaseRef(baseRef) ||
    !/^[0-9a-f]{40}$/i.test(baseSha) ||
    !/^[0-9a-f]{64}$/i.test(idempotencyKey) ||
    !/^[0-9a-f]{64}$/i.test(patchSha256) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId) ||
    !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(issueIdentifier) ||
    parsedIssueUrl.origin !== "https://linear.app"
  ) {
    throw new Error("invalid GitHub publication input");
  }

  return {
    token,
    owner,
    repo,
    baseRef,
    baseSha,
    runId,
    idempotencyKey,
    issueIdentifier,
    issueTitle,
    issueUrl,
    patchPath,
    patchSha256,
    visualEvidence: evidence,
    branch: `maquila/${issueIdentifier.toLowerCase()}-${idempotencyKey.slice(0, 12)}`,
  };
}

async function attachVisualEvidence(input: {
  pullRequest: GitHubPublication;
  pullBody: string;
  evidence: GitHubVisualEvidence;
  directory: string;
  env: NodeJS.ProcessEnv;
  runner: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;
  draft: boolean;
}): Promise<GitHubPublication["visualEvidence"]> {
  const digest = createHash("sha256");
  digest.update(input.evidence.summary);
  for (const item of input.evidence.screenshots) {
    digest.update(item.alt);
    digest.update(readFileSync(item.path));
  }
  if (input.evidence.video) digest.update(readFileSync(input.evidence.video));
  const id = digest.digest("hex");
  const screenshotMarker = `<!-- maquila-ui-evidence:${id}:screenshots -->`;
  const videoMarker = `<!-- maquila-ui-evidence:${id}:video -->`;
  let body = input.pullBody;
  if (!body.includes(screenshotMarker)) {
    body = [
      body.trimEnd(),
      "",
      "## UI evidence",
      "",
      input.evidence.summary,
      "",
      ...input.evidence.screenshots.map(
        (item) => `![${item.alt.replaceAll(/[[\]]/g, "")}](${basename(item.path)})`,
      ),
      "",
      screenshotMarker,
    ].join("\n");
    const bodyPath = join(input.directory, "pr-body-ui.md");
    writeFileSync(bodyPath, `${body.trim()}\n`, { mode: 0o600 });
    await input.runner(
      [
        "pr",
        "edit",
        input.pullRequest.url,
        "--body-file",
        bodyPath,
        ...input.evidence.screenshots.flatMap((item) => ["--attach", `${item.path}#${item.alt}`]),
      ],
      input.directory,
      input.env,
    );
  }
  let result: NonNullable<GitHubPublication["visualEvidence"]> = {
    screenshots: input.evidence.screenshots.length,
    video: "skipped",
  };
  if (input.evidence.video && body.includes(videoMarker)) result.video = "attached";
  else if (input.evidence.video)
    try {
      body = await input.runner(
        ["pr", "view", input.pullRequest.url, "--json", "body", "--jq", ".body"],
        input.directory,
        input.env,
      );
      const bodyPath = join(input.directory, "pr-body-video.md");
      writeFileSync(
        bodyPath,
        `${body.trimEnd()}\n\n### Interaction recording\n\n[View recording](${basename(input.evidence.video)})\n\n${videoMarker}\n`,
        { mode: 0o600 },
      );
      await input.runner(
        [
          "pr",
          "edit",
          input.pullRequest.url,
          "--body-file",
          bodyPath,
          "--attach",
          input.evidence.video,
        ],
        input.directory,
        input.env,
      );
      result.video = "attached";
    } catch {
      result = {
        screenshots: input.evidence.screenshots.length,
        video: "failed",
        warning: "video attachment failed",
      };
    }
  if (input.draft) {
    await input.runner(["pr", "ready", input.pullRequest.url], input.directory, input.env);
    const isDraft = await input.runner(
      ["pr", "view", input.pullRequest.url, "--json", "isDraft", "--jq", ".isDraft"],
      input.directory,
      input.env,
    );
    if (isDraft.trim() !== "false") throw new Error("GitHub pull request remained draft");
  }
  return result;
}

export function createGitHubPublicationDryRun(
  options: GitHubPublicationOptions,
): GitHubPublicationDryRun {
  const value = validateGitHubPublication(options);
  return {
    version: 1,
    mode: "dry-run",
    repository: `${value.owner}/${value.repo}`,
    baseRef: value.baseRef,
    baseSha: value.baseSha,
    runId: value.runId,
    idempotencyKey: value.idempotencyKey,
    issueIdentifier: value.issueIdentifier,
    proposedBranch: value.branch,
    patchSha256: value.patchSha256,
  };
}

export async function publishGitHubPullRequest(
  options: GitHubPublicationOptions,
): Promise<GitHubPublication> {
  const {
    token,
    owner,
    repo,
    baseRef,
    baseSha,
    runId,
    issueIdentifier,
    issueTitle,
    issueUrl,
    patchPath,
    patchSha256,
    visualEvidence: evidence,
    branch,
  } = validateGitHubPublication(options);
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
    GH_TOKEN: token,
    GH_PROMPT_DISABLED: "1",
  };
  const runner = options.runGit ?? runGit;
  const ghRunner = options.runGh ?? runGh;
  const git = (args: string[]) =>
    runner(["-c", "core.hooksPath=/dev/null", ...args], directory, env);
  const fetcher = options.fetch ?? fetch;

  try {
    if (evidence) {
      await ghRunner(["--version"], directory, env);
      const help = await ghRunner(["pr", "edit", "--help"], directory, env);
      if (!help.includes("--attach")) throw new Error("GitHub CLI does not support attachments");
    }
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
      const pull = record(existing[0], "GitHub pull request");
      const result = publication(pull, owner, repo, branch, Boolean(evidence));
      if (result.commitSha !== commitSha)
        throw new Error("GitHub pull request has unexpected content");
      if (!evidence) return result;
      const attached = await attachVisualEvidence({
        pullRequest: result,
        pullBody: typeof pull.body === "string" ? pull.body : "",
        evidence,
        directory,
        env,
        runner: ghRunner,
        draft: pull.draft === true,
      });
      return { ...result, visualEvidence: attached };
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
          draft: Boolean(evidence),
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
    const created = record(
      await responseJson(createResponse, "GitHub pull request"),
      "GitHub pull request",
    );
    const result = publication(created, owner, repo, branch, Boolean(evidence));
    if (result.commitSha !== commitSha)
      throw new Error("GitHub pull request has unexpected content");
    if (!evidence) return result;
    const attached = await attachVisualEvidence({
      pullRequest: result,
      pullBody: typeof created.body === "string" ? created.body : "",
      evidence,
      directory,
      env,
      runner: ghRunner,
      draft: created.draft === true,
    });
    return { ...result, visualEvidence: attached };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
