import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { FactoryConfig } from "./config.js";
import { parseTokenReference } from "./config.js";
import { externalCommandEnvironment } from "./exe.js";

const execFileAsync = promisify(execFile);

export interface ControllerCredentials {
  linearToken: string;
  githubToken: string;
  openRouterKey: string;
  identity?: string;
}

export type CredentialRunner = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<string>;

export interface ResolveControllerCredentialsOptions {
  env?: NodeJS.ProcessEnv;
  identityFlag?: string;
  config?: FactoryConfig;
  runGh?: CredentialRunner;
  runOp?: CredentialRunner;
}

const defaultRunner: CredentialRunner = async (file, args, env) => {
  const result = await execFileAsync(file, args, {
    env,
    encoding: "utf8",
    maxBuffer: 64_000,
  });
  return result.stdout;
};

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function identityFrom(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  if (!isAbsolute(value) || value.includes("\0"))
    throw new Error("exe.dev identity must be an absolute path");
  return value;
}

export async function resolveGithubToken(
  env: NodeJS.ProcessEnv,
  runGh: CredentialRunner = defaultRunner,
): Promise<string> {
  const fromEnv = nonBlank(env.GITHUB_TOKEN) ?? nonBlank(env.GH_TOKEN);
  if (fromEnv) return fromEnv;
  try {
    const token = nonBlank(await runGh("gh", ["auth", "token"], externalCommandEnvironment(env)));
    if (token) return token;
  } catch {
    throw new Error("GitHub CLI auth is unavailable");
  }
  throw new Error("GITHUB_TOKEN is required");
}

export async function resolveLinearToken(
  env: NodeJS.ProcessEnv,
  config: FactoryConfig | undefined,
  runOp: CredentialRunner = defaultRunner,
): Promise<string> {
  const fromEnv = nonBlank(env.LINEAR_API_TOKEN);
  if (fromEnv) return fromEnv;
  const reference = config?.linear?.tokenReference;
  if (!reference) throw new Error("LINEAR_API_TOKEN is required");
  const safe = parseTokenReference(reference);
  try {
    const token = nonBlank(
      await runOp("op", ["read", "--no-newline", safe], externalCommandEnvironment(env)),
    );
    if (token) return token;
  } catch (error) {
    if (error instanceof Error && error.message === "invalid Linear token reference") throw error;
    throw new Error("1Password reference could not be read", { cause: error });
  }
  throw new Error("1Password reference could not be read");
}

export async function resolveOpenRouterKey(
  env: NodeJS.ProcessEnv,
  config: FactoryConfig | undefined,
  runOp: CredentialRunner = defaultRunner,
): Promise<string> {
  const fromEnv = nonBlank(env.OPENROUTER_API_KEY);
  if (fromEnv) return fromEnv;
  const reference = config?.openrouter?.tokenReference;
  if (!reference) throw new Error("OPENROUTER_API_KEY is required");
  const safe = parseTokenReference(reference, "OpenRouter");
  try {
    const key = nonBlank(
      await runOp("op", ["read", "--no-newline", safe], externalCommandEnvironment(env)),
    );
    if (key) return key;
  } catch (error) {
    if (error instanceof Error && error.message === "invalid OpenRouter token reference")
      throw error;
    throw new Error("1Password OpenRouter reference could not be read", { cause: error });
  }
  throw new Error("1Password OpenRouter reference could not be read");
}

export async function resolveControllerCredentials(
  options: ResolveControllerCredentialsOptions = {},
): Promise<ControllerCredentials> {
  const env = options.env ?? process.env;
  const [github, linear, openRouterKey] = await Promise.all([
    resolveGithubToken(env, options.runGh),
    resolveLinearToken(env, options.config, options.runOp),
    resolveOpenRouterKey(env, options.config, options.runOp),
  ]);
  const identity = identityFrom(options.identityFlag ?? env.FACTORY_EXE_IDENTITY);
  return {
    linearToken: linear,
    githubToken: github,
    openRouterKey,
    ...(identity ? { identity } : {}),
  };
}

export function controllerChildEnvironment(
  env: NodeJS.ProcessEnv,
  credentials: ControllerCredentials,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {
    ...externalCommandEnvironment(env),
    LINEAR_API_TOKEN: credentials.linearToken,
    GITHUB_TOKEN: credentials.githubToken,
    OPENROUTER_API_KEY: credentials.openRouterKey,
  };
  if (credentials.identity) child.FACTORY_EXE_IDENTITY = credentials.identity;
  const sock = env.SSH_AUTH_SOCK;
  if (sock !== undefined) {
    if (sock.includes("\0") || !sock.trim()) throw new Error("SSH_AUTH_SOCK is invalid");
    child.SSH_AUTH_SOCK = sock;
  }
  return child;
}
