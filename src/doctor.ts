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
import { ExeClient } from "./integrations/exe.js";
import { fetchGitHubSnapshot } from "./integrations/github.js";
import { fetchLinearIssue, type LinearSnapshot } from "./integrations/linear.js";
import { resolveTargetRepository, type TargetRepository } from "./target.js";

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
  identity?: string;
  issue?: string;
  requireLabel?: string;
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
  fetchLinearIssue?: (options: { token: string; issue: string }) => Promise<LinearSnapshot>;
  fetchGithubSnapshot?: (options: {
    token: string;
    owner: string;
    repo: string;
    baseRef: string;
  }) => Promise<unknown>;
  listVms?: (identity: string | undefined, env: NodeJS.ProcessEnv) => Promise<unknown>;
  write?: (text: string) => void;
}

const GITHUB_URL = "https://github.com/settings/personal-access-tokens/new";
const LINEAR_URL = "https://linear.app/settings/api";
const OPENROUTER_URL = "https://openrouter.ai/settings/keys";
const EXE_URL = "https://exe.dev/docs/cli-ssh-key";
function check(
  id: string,
  ok: boolean,
  pass: string,
  fail: string,
  remediation?: string,
  warn = false,
): DoctorCheck {
  return ok
    ? { id, status: "pass", message: pass }
    : {
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
export function validateDoctorIssueOptions(
  options: Pick<DoctorOptions, "issue" | "requireLabel">,
): void {
  if (options.requireLabel !== undefined && options.issue === undefined)
    throw new Error("--require-label requires --issue");
  for (const [name, value] of [
    ["issue", options.issue],
    ["require-label", options.requireLabel],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        !value.length ||
        value.length > 128 ||
        value !== value.trim() ||
        Array.from(value).some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        }))
    )
      throw new Error(
        `--${name} must be a non-blank, trimmed string of at most 128 characters without controls`,
      );
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  validateDoctorIssueOptions(options);
  const env = options.env ?? process.env,
    write = options.write ?? ((text) => process.stdout.write(text));
  const resolveTarget = options.resolveTarget ?? resolveTargetRepository,
    resolveGithub = options.resolveGithub ?? resolveGithubToken;
  const resolveLinear = options.resolveLinear ?? resolveLinearToken,
    resolveOpenRouter = options.resolveOpenRouter ?? resolveOpenRouterKey;
  const checks: DoctorCheck[] = [];
  let config: MaquilaConfig | undefined;
  let target: TargetRepository | undefined;
  try {
    config = (options.loadConfig ?? loadMaquilaConfig)({ env, homedir: options.homedir });
    checks.push(check("config", true, "maquila config valid", "invalid maquila config"));
  } catch {
    checks.push(check("config", false, "", "invalid maquila config", "fix maquila config"));
  }
  try {
    target = resolveTarget({ target: options.target ?? process.cwd(), env });
    checks.push(
      check(
        "target",
        true,
        "GitHub target resolved",
        "target is not a supported GitHub repository",
        "cd into a GitHub clone or pass --target",
      ),
    );
  } catch {
    checks.push(
      check(
        "target",
        false,
        "",
        "target is not a supported GitHub repository",
        "cd into a GitHub clone or pass --target",
      ),
    );
  }
  const [github, linear, openrouter] = await Promise.allSettled([
    resolveGithub(env),
    resolveLinear(env, config),
    resolveOpenRouter(env, config),
  ]);
  const githubToken = github.status === "fulfilled" ? github.value : undefined;
  let githubOk = Boolean(githubToken && target);
  if (githubToken && target)
    try {
      await (options.fetchGithubSnapshot ?? fetchGitHubSnapshot)({
        token: githubToken,
        owner: target.owner,
        repo: target.repo,
        baseRef: target.baseRef,
      });
    } catch {
      githubOk = false;
    }
  checks.push(
    check(
      "github",
      githubOk,
      "GitHub authenticated read-only target/base probe succeeded",
      "GitHub credential or authenticated target/base read unavailable",
      `gh auth login --web --hostname github.com or export GITHUB_TOKEN\n${GITHUB_URL}`,
    ),
  );
  checks.push(
    check(
      "linear",
      linear?.status === "fulfilled",
      options.issue === undefined
        ? "Linear credential resolves; no API access probe run"
        : "Linear credential resolves; issue access is checked separately",
      "Linear credential unavailable",
      `export LINEAR_API_TOKEN or maquila setup --linear-token-reference op://Vault/Item/field\n${LINEAR_URL}\nhttps://developer.1password.com/docs/cli/get-started/`,
    ),
  );
  if (options.issue !== undefined) {
    try {
      if (linear.status !== "fulfilled" || !linear.value.trim())
        throw new Error("Linear credential unavailable");
      const snapshot = await (options.fetchLinearIssue ?? fetchLinearIssue)({
        token: linear.value,
        issue: options.issue,
      });
      const eligible =
        options.requireLabel === undefined ||
        snapshot.labels.some((label) => label.name === options.requireLabel);
      checks.push(
        check(
          "issue",
          eligible,
          options.requireLabel === undefined
            ? "Linear issue is assigned Todo; no work was started"
            : "Linear issue is assigned Todo and has the required label; no work was started",
          "Linear issue lacks the required label",
          "add the exact required label to the intended issue, then repeat doctor",
        ),
      );
    } catch {
      checks.push(
        check(
          "issue",
          false,
          "",
          "Linear issue access or assigned Todo eligibility could not be verified",
          "check Linear credentials, issue ID, assignee, and Todo state; then repeat doctor",
        ),
      );
    }
  }
  checks.push(
    check(
      "openrouter",
      openrouter?.status === "fulfilled",
      "OpenRouter credential resolves; no authenticated request run",
      "OpenRouter credential unavailable",
      `export OPENROUTER_API_KEY or maquila setup --openrouter-token-reference op://Vault/Item/field\n${OPENROUTER_URL}\nhttps://developer.1password.com/docs/cli/get-started/`,
    ),
  );
  try {
    const available = await (options.resolveModelIds ?? resolveOpenRouterModelIds)();
    const missing = [
      ...new Set(listAgents().map((agent) => agent.model.slice("openrouter/".length))),
    ].filter((model) => !available.has(model));
    checks.push(
      check(
        "models",
        !missing.length,
        "configured OpenRouter models listed anonymously",
        "configured OpenRouter models unavailable",
        "check https://openrouter.ai/api/v1/models",
      ),
    );
  } catch {
    checks.push(
      check(
        "models",
        false,
        "",
        "OpenRouter model catalog unavailable",
        "check https://openrouter.ai/api/v1/models",
      ),
    );
  }
  try {
    const identity = options.identity ?? env.MAQUILA_EXE_IDENTITY;
    if (identity && (!identity.trim() || !isAbsolute(identity) || identity.includes("\0"))) {
      throw new Error("exe.dev identity must be an absolute path");
    }
    await (
      options.listVms ??
      ((file, source) => new ExeClient(undefined, undefined, file, undefined, source).listVms())
    )(identity, env);
    checks.push(
      check(
        "ssh",
        true,
        "exe.dev read-only VM list succeeded; no VM was created",
        "exe.dev SSH access unavailable",
        `ssh exe.dev whoami or maquila doctor --identity /absolute/key\n${EXE_URL}`,
      ),
    );
  } catch {
    checks.push(
      check(
        "ssh",
        false,
        "",
        "exe.dev SSH access unavailable",
        `ssh exe.dev whoami or maquila doctor --identity /absolute/key\n${EXE_URL}`,
      ),
    );
  }
  checks.push(
    check(
      "cli",
      existsSync(resolve(options.maquilaRoot, "dist/src/cli/index.js")) ||
        existsSync(resolve(options.maquilaRoot, "dist/maquila")),
      "maquila CLI build present",
      "maquila CLI build missing",
      "bun run build",
    ),
  );
  const skill = resolve((options.homedir ?? defaultHomedir)(), ".pi", "agent", "skills", "maquila");
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
  const result: DoctorResult = {
    version: 1,
    ok: checks.every((item) => item.status !== "fail"),
    checks,
  };
  if (options.json) write(`${JSON.stringify(result)}\n`);
  else
    for (const item of checks)
      write(
        `${item.id}: ${item.status} — ${item.status === "pass" ? item.message : (item.remediation ?? item.message)}\n`,
      );
  return result;
}
