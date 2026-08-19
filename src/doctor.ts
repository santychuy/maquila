import { existsSync } from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { loadFactoryConfig, type FactoryConfig } from "./config.js";
import { resolveGithubToken, resolveLinearToken, type CredentialRunner } from "./credentials.js";
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
  factoryRoot: string;
  homedir?: typeof defaultHomedir;
  resolveTarget?: typeof resolveTargetRepository;
  resolveGithub?: (env: NodeJS.ProcessEnv, runner?: CredentialRunner) => Promise<string>;
  resolveLinear?: (
    env: NodeJS.ProcessEnv,
    config: FactoryConfig | undefined,
    runner?: CredentialRunner,
  ) => Promise<string>;
  loadConfig?: typeof loadFactoryConfig;
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

function sshReady(env: NodeJS.ProcessEnv, home: string): boolean {
  const identity = env.FACTORY_EXE_IDENTITY?.trim();
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
  const loadConfig = options.loadConfig ?? loadFactoryConfig;
  const resolveTarget = options.resolveTarget ?? resolveTargetRepository;
  const resolveGithub = options.resolveGithub ?? resolveGithubToken;
  const resolveLinear = options.resolveLinear ?? resolveLinearToken;
  const checks: DoctorCheck[] = [];
  let config: FactoryConfig | undefined;
  try {
    config = loadConfig({ env, homedir: options.homedir });
    checks.push(check("config", true, "factory config valid", "invalid factory config"));
  } catch {
    checks.push(
      check("config", false, "", "invalid factory config", "fix ~/.config/factory/config.json"),
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
    const [github, linear] = await Promise.allSettled([
      resolveGithub(env),
      resolveLinear(env, config),
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
        "export LINEAR_API_TOKEN or factory setup --linear-token-reference op://Vault/Item/field",
      ),
    );
  } else {
    checks.push(
      check("github", false, "", "GitHub credential not checked", "fix factory config first"),
    );
    checks.push(
      check("linear", false, "", "Linear credential not checked", "fix factory config first"),
    );
  }
  const home = (options.homedir ?? defaultHomedir)();
  checks.push(
    check(
      "ssh",
      sshReady(env, home),
      "exe.dev SSH identity, agent, or user config available",
      "no exe.dev identity, SSH agent, or OpenSSH user config",
      "start ssh-agent or set FACTORY_EXE_IDENTITY",
    ),
  );
  const cli = resolve(options.factoryRoot, "dist/src/cli.js");
  checks.push(
    check(
      "cli",
      existsSync(cli),
      "factory CLI build present",
      "dist/src/cli.js missing",
      "pnpm run build",
    ),
  );
  const skill = resolve(home, ".pi", "agent", "skills", "software-factory");
  checks.push(
    check(
      "skill",
      existsSync(skill),
      "user-scope factory skill installed",
      "user-scope factory skill not installed",
      "factory setup --install-skill",
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
