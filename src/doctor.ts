import { existsSync } from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { listAgents } from "./agents/index.js";
import { loadMaquilaConfig, type MaquilaConfig } from "./config.js";
import {
  resolveGithubToken,
  resolveLinearToken,
  resolveOpenRouterKey,
  type CredentialRunner,
} from "./credentials.js";
import { resolveTargetRepository } from "./target.js";

export type CheckStatus = "pass" | "fail" | "warn";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
}

export interface DoctorResult {
  version: 1;
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  json?: boolean;
  target?: string;
  env?: NodeJS.ProcessEnv;
  maquilaRoot: string;
  homedir?: typeof defaultHomedir;
  resolveTarget?: typeof resolveTargetRepository;
  resolveGithub?: (env: NodeJS.ProcessEnv, runner?: CredentialRunner) => Promise<string>;
  resolveLinear?: (
    env: NodeJS.ProcessEnv,
    config: MaquilaConfig | undefined,
    runner?: CredentialRunner,
  ) => Promise<string>;
  resolveOpenRouter?: (
    env: NodeJS.ProcessEnv,
    config: MaquilaConfig | undefined,
    runner?: CredentialRunner,
  ) => Promise<string>;
  resolveModelIds?: () => Promise<Set<string>>;
  loadConfig?: typeof loadMaquilaConfig;
  write?: (text: string) => void;
}

function check(
  id: string,
  ok: boolean,
  pass: string,
  fail: string,
  remediation?: string,
  warn = false,
): DoctorCheck {
  if (ok) return { id, status: "pass", message: pass };
  return {
    id,
    status: warn ? "warn" : "fail",
    message: fail,
    ...(remediation ? { remediation } : {}),
  };
}

async function resolveOpenRouterModelIds(): Promise<Set<string>> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("OpenRouter model catalog unavailable");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data))
    throw new Error("OpenRouter model catalog invalid");
  return new Set(
    value.data.flatMap((item) =>
      item && typeof item === "object" && "id" in item && typeof item.id === "string"
        ? [item.id]
        : [],
    ),
  );
}

function sshReady(env: NodeJS.ProcessEnv, home: string): boolean {
  const identity = env.MAQUILA_EXE_IDENTITY?.trim();
  if (identity) return isAbsolute(identity) && !identity.includes("\0") && existsSync(identity);
  const sock = env.SSH_AUTH_SOCK;
  if (sock && sock.trim() && !sock.includes("\0")) return true;
  return (
    existsSync(resolve(home, ".ssh", "config")) ||
    ["id_ed25519", "id_rsa", "id_ecdsa"].some((name) => existsSync(resolve(home, ".ssh", name)))
  );
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const env = options.env ?? process.env;
  const targetPath = options.target ?? process.cwd();
  const write = options.write ?? ((text) => process.stdout.write(text));
  const loadConfig = options.loadConfig ?? loadMaquilaConfig;
  const resolveTarget = options.resolveTarget ?? resolveTargetRepository;
  const resolveGithub = options.resolveGithub ?? resolveGithubToken;
  const resolveLinear = options.resolveLinear ?? resolveLinearToken;
  const resolveOpenRouter = options.resolveOpenRouter ?? resolveOpenRouterKey;
  const checks: DoctorCheck[] = [];
  let config: MaquilaConfig | undefined;
  try {
    config = loadConfig({ env, homedir: options.homedir });
    checks.push(check("config", true, "maquila config valid", "invalid maquila config"));
  } catch {
    checks.push(
      check("config", false, "", "invalid maquila config", "fix ~/.config/maquila/config.json"),
    );
  }
  try {
    const target = resolveTarget({ target: targetPath, env });
    checks.push(
      check(
        "target",
        true,
        `${target.owner}/${target.repo}`,
        "target is not a supported GitHub repository",
      ),
    );
  } catch (error) {
    checks.push(
      check(
        "target",
        false,
        "",
        error instanceof Error ? error.message : "target is not a supported GitHub repository",
        "cd into a GitHub clone or pass --target",
      ),
    );
  }
  if (config) {
    const [github, linear, openrouter] = await Promise.allSettled([
      resolveGithub(env),
      resolveLinear(env, config),
      resolveOpenRouter(env, config),
    ]);
    checks.push(
      check(
        "github",
        github.status === "fulfilled",
        "GitHub credential resolvable",
        "GitHub credential unavailable",
        "gh auth login or export GITHUB_TOKEN",
      ),
    );
    checks.push(
      check(
        "linear",
        linear.status === "fulfilled",
        "Linear credential resolvable",
        "Linear credential unavailable",
        "export LINEAR_API_TOKEN or maquila setup --linear-token-reference op://Vault/Item/field",
      ),
    );
    checks.push(
      check(
        "openrouter",
        openrouter.status === "fulfilled",
        "OpenRouter credential resolvable",
        "OpenRouter credential unavailable",
        "export OPENROUTER_API_KEY or maquila setup --openrouter-token-reference op://Vault/Item/field",
      ),
    );
  } else {
    checks.push(
      check("github", false, "", "GitHub credential not checked", "fix maquila config first"),
    );
    checks.push(
      check("linear", false, "", "Linear credential not checked", "fix maquila config first"),
    );
    checks.push(
      check(
        "openrouter",
        false,
        "",
        "OpenRouter credential not checked",
        "fix maquila config first",
      ),
    );
  }
  try {
    const available = await (options.resolveModelIds ?? resolveOpenRouterModelIds)();
    const configured = [
      ...new Set(listAgents().map((agent) => agent.model.slice("openrouter/".length))),
    ];
    const missing = configured.filter((model) => !available.has(model));
    checks.push(
      check(
        "models",
        missing.length === 0,
        "configured OpenRouter models available",
        `configured OpenRouter models unavailable: ${missing.join(", ")}`,
        "pin available model IDs in src/agents/*.md",
      ),
    );
  } catch {
    checks.push(
      check(
        "models",
        false,
        "",
        "OpenRouter model catalog unavailable",
        "check network access to https://openrouter.ai/api/v1/models",
      ),
    );
  }
  const home = (options.homedir ?? defaultHomedir)();
  checks.push(
    check(
      "ssh",
      sshReady(env, home),
      "exe.dev SSH identity, agent, or user config available",
      "no exe.dev identity, SSH agent, or OpenSSH user config",
      "start ssh-agent or set MAQUILA_EXE_IDENTITY",
    ),
  );
  const cli = resolve(options.maquilaRoot, "dist/maquila");
  checks.push(
    check(
      "cli",
      existsSync(cli),
      "maquila CLI build present",
      "dist/maquila missing",
      "bun run build",
    ),
  );
  const skill = resolve(home, ".pi", "agent", "skills", "maquila");
  checks.push(
    check(
      "skill",
      existsSync(skill),
      "user-scope maquila skill installed",
      "user-scope maquila skill not installed",
      "maquila setup --install-skill",
      true,
    ),
  );
  const ok = checks.every((item) => item.status !== "fail");
  const result: DoctorResult = { version: 1, ok, checks };
  if (options.json) write(`${JSON.stringify(result)}\n`);
  else {
    for (const item of checks) {
      const extra = item.status === "pass" ? item.message : (item.remediation ?? item.message);
      write(`${item.id}: ${item.status}${extra ? ` — ${extra}` : ""}\n`);
    }
  }
  return result;
}
