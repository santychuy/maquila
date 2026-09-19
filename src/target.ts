import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  EXE_TAG_MAX_LENGTH,
  EXE_TAG_PATTERN,
  assertExeTag,
  externalCommandEnvironment,
} from "./integrations/exe.js";

const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;

export interface TargetRepository {
  path: string;
  owner: string;
  repo: string;
  baseRef: string;
  tag: string;
}

interface GitOptions {
  cwd: string;
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
}

export interface ResolveTargetOptions {
  target: string;
  owner?: string;
  repo?: string;
  baseRef?: string;
  tag?: string;
  git?: (cwd: string, args: string[]) => string;
  env?: NodeJS.ProcessEnv;
  execGit?: (file: string, args: string[], options: GitOptions) => string;
}

export function defaultGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  execGit: (file: string, args: string[], options: GitOptions) => string = (file, argv, options) =>
    execFileSync(file, argv, options),
): string {
  try {
    return execGit("git", args, {
      cwd,
      encoding: "utf8",
      env: externalCommandEnvironment(env),
    }).trim();
  } catch {
    throw new Error("cannot inspect target Git repository");
  }
}

function safeName(value: string, label: string): string {
  if (!SAFE_NAME.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

export function parseGitHubOrigin(origin: string): { owner: string; repo: string } {
  const match = origin
    .trim()
    .match(
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
    );
  if (!match?.[1] || !match[2]) throw new Error("target origin must be a GitHub repository");
  return { owner: safeName(match[1], "owner"), repo: safeName(match[2], "repository") };
}

function validRefShape(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !/[ ~^:?*\\[\\]]/.test(value)
  );
}

export function validateResolvedTarget(input: {
  owner: string;
  repo: string;
  baseRef: string;
  tag: string;
}): Omit<TargetRepository, "path"> {
  const owner = safeName(input.owner, "owner");
  const repo = safeName(input.repo, "repository");
  const tag = assertExeTag(input.tag);
  if (!validRefShape(input.baseRef)) throw new Error("invalid base ref");
  return { owner, repo, baseRef: input.baseRef, tag };
}

/** Default exe.dev tag: keep provider-valid defaults unchanged, else slug owner-repo. */
export function defaultExeTag(owner: string, repo: string): string {
  const candidate = `${owner}-${repo}`;
  if (candidate.length <= EXE_TAG_MAX_LENGTH && EXE_TAG_PATTERN.test(candidate)) return candidate;
  let slug = candidate
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/-{2,}/g, "-");
  if (!/^[a-z]/.test(slug)) slug = `t-${slug.replaceAll(/^[^a-z]+/g, "") || "tag"}`;
  slug = slug.slice(0, EXE_TAG_MAX_LENGTH).replaceAll(/[-_]+$/g, "") || "t-tag";
  if (!EXE_TAG_PATTERN.test(slug)) throw new Error("cannot derive valid exe.dev tag");
  return slug;
}

export function resolveTargetRepository(options: ResolveTargetOptions): TargetRepository {
  const git =
    options.git ??
    ((cwd: string, args: string[]) => defaultGit(cwd, args, options.env, options.execGit));
  const requested = resolve(options.target);
  const path = resolve(git(requested, ["rev-parse", "--show-toplevel"]));
  const inferred = parseGitHubOrigin(git(path, ["remote", "get-url", "origin"]));
  const symbolic = git(path, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  const prefix = "refs/remotes/origin/";
  if (!symbolic.startsWith(prefix) || symbolic.length === prefix.length)
    throw new Error("target origin HEAD is unavailable");
  const owner = safeName(options.owner ?? inferred.owner, "owner");
  const repo = safeName(options.repo ?? inferred.repo, "repository");
  const baseRef = options.baseRef ?? symbolic.slice(prefix.length);
  if (!validRefShape(baseRef)) throw new Error("invalid base ref");
  const checkedRef = git(path, ["check-ref-format", "--branch", baseRef]);
  if (checkedRef !== baseRef) throw new Error("invalid base ref");
  const tag = options.tag === undefined ? defaultExeTag(owner, repo) : assertExeTag(options.tag);
  return { path, owner, repo, baseRef, tag };
}
