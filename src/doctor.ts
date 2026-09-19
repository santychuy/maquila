import { existsSync } from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { isAgentMode, renderAgentProgress } from "./agent-mode.js";
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
import {
  fetchLinearIdentity,
  fetchLinearIssue,
  type LinearIdentity,
  type LinearSnapshot,
} from "./integrations/linear.js";
import { resolveTargetRepository, type TargetRepository } from "./target.js";

export const DEFAULT_REQUIRED_LABEL = "maquila-ready";
export type CheckStatus = "pass" | "fail" | "warn";
export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
}
export interface OpenRouterKeyStatus {
  limit: number | null;
  limitRemaining: number | null;
  usage: number;
  limitReset: string | null;
  includeByokInLimit: boolean;
}
export interface DoctorResult {
  version: 1;
  ok: boolean;
  checks: DoctorCheck[];
  linearIdentity?: LinearIdentity;
  openRouterKey?: OpenRouterKeyStatus;
}
export interface DoctorOptions {
  json?: boolean;
  agent?: boolean;
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
  fetchLinearIdentity?: (options: { token: string }) => Promise<LinearIdentity>;
  fetchOpenRouterKey?: (options: { key: string }) => Promise<OpenRouterKeyStatus>;
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
function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function parseOpenRouterKey(value: unknown): OpenRouterKeyStatus {
  if (!value || typeof value !== "object" || !("data" in value)) throw new Error("invalid");
  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid");
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(data));
  const limit = fields.limit;
  const remaining = fields.limit_remaining;
  const reset = fields.limit_reset;
  if (limit !== null && (!finiteNumber(limit) || limit < 0)) throw new Error("invalid");
  if (remaining !== null && !finiteNumber(remaining)) throw new Error("invalid");
  if ((limit === null) !== (remaining === null)) throw new Error("invalid");
  if (limit !== null && remaining !== null && remaining > limit) throw new Error("invalid");
  if (!finiteNumber(fields.usage) || fields.usage < 0) throw new Error("invalid");
  if (reset !== null && reset !== "daily" && reset !== "weekly" && reset !== "monthly")
    throw new Error("invalid");
  if (typeof fields.include_byok_in_limit !== "boolean") throw new Error("invalid");
  return {
    limit,
    limitRemaining: remaining,
    usage: fields.usage,
    limitReset: reset,
    includeByokInLimit: fields.include_byok_in_limit,
  };
}
export async function fetchOpenRouterKey(options: { key: string }): Promise<OpenRouterKeyStatus> {
  if (!options.key.trim()) throw new Error("OpenRouter key unavailable");
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${options.key}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("OpenRouter key request failed");
  }
  if (!response.ok) throw new Error("OpenRouter key request failed");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("OpenRouter key response invalid");
  }
  return parseOpenRouterKey(body);
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
  let linearIdentity: LinearIdentity | undefined;
  let openRouterKey: OpenRouterKeyStatus | undefined;
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
      "Linear credential resolves",
      "Linear credential unavailable",
      `run maquila setup to paste a Linear API key, or export LINEAR_API_TOKEN\noptional: maquila setup --linear-token-reference op://Vault/Item/field\n${LINEAR_URL}`,
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
            : `Linear issue is assigned Todo and has the required "${options.requireLabel}" label; no work was started`,
          `Linear issue lacks the required "${options.requireLabel ?? DEFAULT_REQUIRED_LABEL}" label`,
          `add the exact required label to the intended issue, then repeat doctor`,
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
  if (linear.status === "fulfilled" && linear.value.trim()) {
    try {
      linearIdentity = await (options.fetchLinearIdentity ?? fetchLinearIdentity)({
        token: linear.value,
      });
      checks.push(
        check(
          "workspace",
          true,
          `Linear user ${linearIdentity.user.name} in workspace ${linearIdentity.workspace.name} (${linearIdentity.workspace.urlKey})`,
          "Linear workspace identity unavailable",
        ),
      );
    } catch {
      checks.push(
        check(
          "workspace",
          false,
          "",
          "Linear workspace identity unavailable",
          "check Linear credentials and repeat doctor",
        ),
      );
    }
  } else {
    checks.push(
      check(
        "workspace",
        false,
        "",
        "Linear workspace identity unavailable",
        "run maquila setup to paste a Linear API key, or export LINEAR_API_TOKEN",
      ),
    );
  }
  checks.push(
    check(
      "openrouter",
      openrouter?.status === "fulfilled",
      "OpenRouter credential resolves",
      "OpenRouter credential unavailable",
      `run maquila setup to paste an OpenRouter API key, or export OPENROUTER_API_KEY\noptional: maquila setup --openrouter-token-reference op://Vault/Item/field\n${OPENROUTER_URL}`,
    ),
  );
  if (openrouter.status === "fulfilled" && openrouter.value.trim()) {
    try {
      openRouterKey = await (options.fetchOpenRouterKey ?? fetchOpenRouterKey)({
        key: openrouter.value,
      });
      const exhausted =
        openRouterKey.limit !== null &&
        openRouterKey.limitRemaining !== null &&
        openRouterKey.limitRemaining <= 0;
      const unlimited = openRouterKey.limit === null;
      const resetting = openRouterKey.limitReset !== null;
      const byokExcluded = !openRouterKey.includeByokInLimit;
      const cap = openRouterKey.limit === null ? "unlimited" : String(openRouterKey.limit);
      const remaining =
        openRouterKey.limitRemaining === null ? "unknown" : String(openRouterKey.limitRemaining);
      const reset = openRouterKey.limitReset ?? "none";
      const message = `OpenRouter limit ${cap}, remaining ${remaining}, reset ${reset}`;
      if (exhausted)
        checks.push(
          check(
            "credits",
            false,
            "",
            `${message}; remaining credits are exhausted`,
            "add credits on a dedicated capped OpenRouter key",
          ),
        );
      else if (unlimited || resetting || byokExcluded) {
        const reasons = [
          unlimited ? "unlimited cap is not a spend lock" : undefined,
          resetting ? "limit resets; remaining is not a fixed lock" : undefined,
          byokExcluded ? "BYOK usage is excluded from this limit" : undefined,
        ].filter((item): item is string => Boolean(item));
        checks.push(
          check("credits", false, "", `${message}; ${reasons.join("; ")}`, undefined, true),
        );
      } else checks.push(check("credits", true, message, "OpenRouter key limits unavailable"));
    } catch {
      checks.push(
        check(
          "credits",
          false,
          "",
          "OpenRouter key limits unavailable",
          "check OPENROUTER_API_KEY and repeat doctor",
        ),
      );
    }
  } else {
    checks.push(
      check(
        "credits",
        false,
        "",
        "OpenRouter key limits unavailable",
        "run maquila setup to paste an OpenRouter API key, or export OPENROUTER_API_KEY",
      ),
    );
  }
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
    ...(linearIdentity ? { linearIdentity } : {}),
    ...(openRouterKey ? { openRouterKey } : {}),
  };
  if (options.json) write(`${JSON.stringify(result)}\n`);
  else if (isAgentMode(options.agent, env)) write(renderAgentProgress(result));
  else
    for (const item of checks)
      write(
        `${item.id}: ${item.status} — ${item.status === "pass" ? item.message : (item.remediation ?? item.message)}\n`,
      );
  return result;
}
