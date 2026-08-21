import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  factoryConfigPath,
  loadFactoryConfig,
  parseTokenReference,
  writeFactoryConfig,
} from "./config.js";
import { externalCommandEnvironment } from "./integrations/exe.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SetupRunner = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ ok: boolean }>;

export interface SetupOptions {
  json?: boolean;
  linearTokenReference?: string;
  openRouterTokenReference?: string;
  installSkill?: boolean;
  stdinIsTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  factoryRoot: string;
  homedir?: typeof defaultHomedir;
  runGh?: SetupRunner;
  runOp?: SetupRunner;
  prompt?: (message: string) => Promise<string>;
  write?: (text: string) => void;
}

export interface SetupResult {
  version: 1;
  ok: true;
  configPath: string;
  github: { available: boolean; remediation?: string };
  linear: { configured: boolean; remediation?: string };
  openrouter: { configured: boolean; remediation?: string };
  ssh: { available: boolean; remediation?: string };
  skill: { installed: boolean; path?: string; remediation?: string };
}

const defaultRunner: SetupRunner = async (file, args, env) => {
  try {
    await execFileAsync(file, args, { env, encoding: "utf8", maxBuffer: 64_000 });
    return { ok: true };
  } catch {
    return { ok: false };
  }
};

function openSshConfigured(home: string): boolean {
  return (
    existsSync(resolve(home, ".ssh", "config")) ||
    ["id_ed25519", "id_rsa", "id_ecdsa"].some((name) => existsSync(resolve(home, ".ssh", name)))
  );
}

function skillDestination(home: string): string {
  return resolve(home, ".pi", "agent", "skills", "software-factory");
}

export function installFactorySkill(factoryRoot: string, destination: string): boolean {
  const source = resolve(factoryRoot, ".pi", "skills", "software-factory");
  mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
  if (existsSync(destination) || lstatExists(destination)) {
    const current = readlinkSync(destination);
    if (resolve(current) === source) return false;
    throw new Error("factory skill destination already exists");
  }
  symlinkSync(source, destination);
  return true;
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultPrompt(message: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const env = options.env ?? process.env;
  const home = (options.homedir ?? defaultHomedir)();
  const write = options.write ?? ((text) => process.stdout.write(text));
  const runGh = options.runGh ?? defaultRunner;
  const runOp = options.runOp ?? defaultRunner;
  const commandEnv = externalCommandEnvironment(env);
  const github = await runGh("gh", ["auth", "status"], commandEnv);
  const op = await runOp("op", ["--version"], commandEnv);
  const sock = Boolean(env.SSH_AUTH_SOCK?.trim()) && !env.SSH_AUTH_SOCK?.includes("\0");
  const sshAvailable = sock || openSshConfigured(home);
  let config = loadFactoryConfig({ env, homedir: options.homedir });
  let linearReference = options.linearTokenReference?.trim();
  let openRouterReference = options.openRouterTokenReference?.trim();
  if (!linearReference && !openRouterReference && (options.stdinIsTTY ?? input.isTTY ?? false)) {
    const answer = await (options.prompt ?? defaultPrompt)(
      "Linear 1Password reference (op://Vault/Item/field, empty to skip): ",
    );
    linearReference = answer.trim();
  }
  if (linearReference || openRouterReference) {
    config = {
      ...config,
      ...(linearReference
        ? { linear: { tokenReference: parseTokenReference(linearReference) } }
        : {}),
      ...(openRouterReference
        ? { openrouter: { tokenReference: parseTokenReference(openRouterReference, "OpenRouter") } }
        : {}),
    };
    writeFactoryConfig(config, { env, homedir: options.homedir ?? defaultHomedir });
  } else if (!existsSync(factoryConfigPath(env, options.homedir ?? defaultHomedir))) {
    writeFactoryConfig({ version: 1 }, { env, homedir: options.homedir ?? defaultHomedir });
  }
  const configPath = factoryConfigPath(env, options.homedir ?? defaultHomedir);
  const skillPath = skillDestination(home);
  let skillInstalled = false;
  if (options.installSkill) {
    installFactorySkill(options.factoryRoot, skillPath);
    skillInstalled = true;
  } else if (lstatExists(skillPath)) {
    try {
      skillInstalled =
        resolve(readlinkSync(skillPath)) ===
        resolve(options.factoryRoot, ".pi", "skills", "software-factory");
    } catch {
      skillInstalled = false;
    }
  }
  const result: SetupResult = {
    version: 1,
    ok: true,
    configPath,
    github: github.ok ? { available: true } : { available: false, remediation: "gh auth login" },
    linear: config.linear
      ? { configured: true }
      : {
          configured: false,
          remediation:
            "export LINEAR_API_TOKEN or factory setup --linear-token-reference op://Vault/Item/field",
        },
    openrouter: config.openrouter
      ? { configured: true }
      : {
          configured: false,
          remediation:
            "export OPENROUTER_API_KEY or factory setup --openrouter-token-reference op://Vault/Item/field",
        },
    ssh: sshAvailable
      ? { available: true }
      : {
          available: false,
          remediation: "configure ~/.ssh/config, start ssh-agent, or set FACTORY_EXE_IDENTITY",
        },
    skill: skillInstalled
      ? { installed: true, path: skillPath }
      : {
          installed: false,
          path: skillPath,
          remediation: "factory setup --install-skill",
        },
  };
  if (options.json) write(`${JSON.stringify(result)}\n`);
  else {
    write(`Config: ${configPath}\n`);
    write(`GitHub: ${result.github.available ? "ok" : result.github.remediation}\n`);
    write(`Linear: ${result.linear.configured ? "ok" : result.linear.remediation}\n`);
    write(`OpenRouter: ${result.openrouter.configured ? "ok" : result.openrouter.remediation}\n`);
    write(`SSH: ${result.ssh.available ? "ok" : result.ssh.remediation}\n`);
    write(`Skill: ${result.skill.installed ? result.skill.path : result.skill.remediation}\n`);
    if (!op.ok) write("Optional: install 1Password CLI to use op:// references\n");
  }
  return result;
}
