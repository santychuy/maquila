import { execFile, execFileSync } from "node:child_process";
import { isAbsolute, normalize, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const VERIFY_CONFIG_NAME = "maquila.verify.json";
export const DEFAULT_COMMAND_TIMEOUT_MS = 900_000;

export interface VerifyConfig {
  commands: string[][];
}

export interface CommandEvidence {
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface GitGateResult {
  passed: boolean;
  baseSha: string;
  headSha: string;
  changedPaths: string[];
  unexpectedPaths: string[];
  reason: string | null;
}

export interface VerificationResult {
  passed: boolean;
  config: VerifyConfig;
  commands: CommandEvidence[];
  git: GitGateResult;
}

export interface VerifyOptions {
  repo: string;
  baseSha: string;
  allowedPaths: string[];
  commandTimeoutMs?: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-blank string`);
  return value;
}

function exactSha(value: unknown): string {
  const sha = nonBlank(value, "baseSha");
  if (!/^[0-9a-f]{40}$/i.test(sha)) fail("baseSha must be a 40-character Git SHA");
  return sha;
}

export function parseVerifyConfig(raw: unknown): VerifyConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("maquila.verify.json must be an object");
  }
  const unknown = Object.keys(raw).filter((key) => key !== "commands");
  if (unknown.length) fail(`unknown fields: ${unknown.join(", ")}`);
  if (!("commands" in raw) || !Array.isArray(raw.commands) || raw.commands.length === 0) {
    fail("commands must be a non-empty array");
  }

  const commands = raw.commands.map((argv, index) => {
    if (!Array.isArray(argv) || argv.length === 0) {
      fail(`commands[${index}] must be a non-empty argv array`);
    }
    return argv.map((part, partIndex) => nonBlank(part, `commands[${index}][${partIndex}]`));
  });

  return { commands };
}

export function loadVerifyConfig(repo: string, baseSha: string): VerifyConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(git(repo, "show", `${exactSha(baseSha)}:${VERIFY_CONFIG_NAME}`));
  } catch (error) {
    fail(
      `cannot read ${VERIFY_CONFIG_NAME} at base SHA: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseVerifyConfig(parsed);
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function splitNul(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

export function assertSafeRepoPath(path: string): string {
  const trimmed = nonBlank(path, "path");
  if (isAbsolute(trimmed) || trimmed.startsWith("/")) fail(`unsafe path: ${trimmed}`);
  const portable = trimmed.replaceAll("\\", "/");
  const normalized = normalize(portable);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized.includes(`${sep}..`)) {
    fail(`unsafe path: ${trimmed}`);
  }
  if (normalized.startsWith(sep) || isAbsolute(normalized)) fail(`unsafe path: ${trimmed}`);
  const result = normalized.split(sep).join("/");
  if (result.split("/").includes(".git")) fail(`unsafe path: ${trimmed}`);
  return result;
}

function isAllowed(path: string, allowed: Set<string>): boolean {
  if (allowed.has(path)) return true;
  for (const prefix of allowed) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export function changedPaths(repo: string): string[] {
  const tracked = splitNul(git(repo, "diff", "--no-renames", "--name-only", "-z", "HEAD"));
  const staged = splitNul(git(repo, "diff", "--cached", "--no-renames", "--name-only", "-z"));
  const untracked = splitNul(git(repo, "ls-files", "--others", "--exclude-standard", "-z"));
  return [...new Set([...tracked, ...staged, ...untracked])].toSorted();
}

export function assertCleanBaseline(repo: string, baseSha: string): void {
  const expectedBase = exactSha(baseSha);
  const headSha = git(repo, "rev-parse", "HEAD").trim();
  if (headSha !== expectedBase) fail("HEAD does not equal recorded base SHA");
  if (changedPaths(repo).length) fail("worktree is not clean at recorded base SHA");
}

export function evaluateGitGate(
  repo: string,
  baseSha: string,
  allowedPaths: string[],
): GitGateResult {
  const expectedBase = exactSha(baseSha);
  const allowed = new Set(allowedPaths.map(assertSafeRepoPath));
  const headSha = git(repo, "rev-parse", "HEAD").trim();

  if (headSha !== expectedBase) {
    return {
      passed: false,
      baseSha: expectedBase,
      headSha,
      changedPaths: [],
      unexpectedPaths: [],
      reason: "HEAD moved from recorded base SHA",
    };
  }

  const paths = changedPaths(repo);
  if (paths.length === 0) {
    return {
      passed: false,
      baseSha: expectedBase,
      headSha,
      changedPaths: [],
      unexpectedPaths: [],
      reason: "empty diff",
    };
  }

  const unexpectedPaths = paths.filter(
    (path) => path === VERIFY_CONFIG_NAME || !isAllowed(path, allowed),
  );
  if (unexpectedPaths.length) {
    return {
      passed: false,
      baseSha: expectedBase,
      headSha,
      changedPaths: paths,
      unexpectedPaths,
      reason: "unexpected paths outside approved set",
    };
  }

  return {
    passed: true,
    baseSha: expectedBase,
    headSha,
    changedPaths: paths,
    unexpectedPaths: [],
    reason: null,
  };
}

async function runCommand(
  repo: string,
  argv: string[],
  timeoutMs: number,
): Promise<CommandEvidence> {
  const [file, ...args] = argv;
  if (!file) fail("command argv missing executable");
  const started = Date.now();
  try {
    const result = await execFileAsync(file, args, {
      cwd: repo,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      argv,
      exitCode: 0,
      timedOut: false,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const fields = error && typeof error === "object" ? error : {};
    const killed = "killed" in fields && fields.killed === true;
    const code = "code" in fields ? fields.code : undefined;
    const status = "status" in fields ? fields.status : undefined;
    const timedOut = killed || code === "ETIMEDOUT";
    const exitCode = typeof status === "number" ? status : typeof code === "number" ? code : null;
    const stdout = "stdout" in fields && typeof fields.stdout === "string" ? fields.stdout : "";
    const stderr =
      "stderr" in fields && typeof fields.stderr === "string"
        ? fields.stderr
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      argv,
      exitCode: timedOut ? null : exitCode,
      timedOut,
      stdout,
      stderr,
      durationMs: Date.now() - started,
    };
  }
}

export async function verifyRepository(options: VerifyOptions): Promise<VerificationResult> {
  const repo = options.repo;
  const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    fail("commandTimeoutMs must be a positive integer");
  }

  const config = loadVerifyConfig(repo, options.baseSha);
  const commands: CommandEvidence[] = [];
  let commandsPassed = true;

  for (const argv of config.commands) {
    const evidence = await runCommand(repo, argv, timeoutMs);
    commands.push(evidence);
    if (evidence.timedOut || evidence.exitCode !== 0) {
      commandsPassed = false;
      break;
    }
  }

  const gitGate = evaluateGitGate(repo, options.baseSha, options.allowedPaths);
  return {
    passed: commandsPassed && gitGate.passed,
    config,
    commands,
    git: gitGate,
  };
}
