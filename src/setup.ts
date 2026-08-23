import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadMaquilaConfig, parseTokenReference, writeMaquilaConfig } from "./config.js";
import { resolveLinearToken, resolveOpenRouterKey, type CredentialRunner } from "./credentials.js";
import { runDoctor, type DoctorOptions, type DoctorResult } from "./doctor.js";

const LINEAR_URL = "https://linear.app/settings/api";
const OPENROUTER_URL = "https://openrouter.ai/settings/keys";
const OP_URL = "https://developer.1password.com/docs/cli/get-started/";
export interface SetupOptions extends Pick<
  DoctorOptions,
  "target" | "identity" | "env" | "homedir"
> {
  json?: boolean;
  linearTokenReference?: string;
  openRouterTokenReference?: string;
  installSkill?: boolean;
  maquilaRoot: string;
  stdinIsTTY?: boolean;
  prompt?: (message: string) => Promise<string>;
  write?: (text: string) => void;
  runOp?: CredentialRunner;
  runDoctor?: typeof runDoctor;
}

export class SetupCancelled extends Error {
  readonly code = "SIGINT";
}
export interface SetupResult {
  version: 2;
  ok: boolean;
  checks: DoctorResult["checks"];
}
function skillDestination(home: string): string {
  return resolve(home, ".pi", "agent", "skills", "maquila");
}
function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
export function installMaquilaSkill(maquilaRoot: string, destination: string): boolean {
  const source = resolve(maquilaRoot, ".pi", "skills", "maquila");
  mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
  if (existsSync(destination) || lstatExists(destination)) {
    try {
      if (resolve(readlinkSync(destination)) === source) return false;
    } catch {}
    throw new Error("maquila skill destination already exists");
  }
  symlinkSync(source, destination);
  return true;
}
async function defaultPrompt(message: string): Promise<string> {
  const rl = createInterface({ input, output });
  const interrupted = new Promise<never>((_resolve, reject) => {
    rl.once("SIGINT", () => reject(new SetupCancelled()));
  });
  try {
    return await Promise.race([rl.question(message), interrupted]);
  } finally {
    rl.close();
  }
}

async function promptAnswer(
  ask: (message: string) => Promise<string>,
  message: string,
): Promise<string> {
  try {
    return await ask(message);
  } catch (error) {
    if (
      error instanceof SetupCancelled ||
      (error && typeof error === "object" && "code" in error && error.code === "SIGINT")
    )
      throw new SetupCancelled();
    throw error;
  }
}
function without(env: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy[key];
  return copy;
}
export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const env = options.env ?? process.env,
    write = options.write ?? ((text) => process.stdout.write(text));
  const home = (options.homedir ?? defaultHomedir)(),
    direct =
      options.linearTokenReference !== undefined ||
      options.openRouterTokenReference !== undefined ||
      options.installSkill === true;
  let config = loadMaquilaConfig({ env, homedir: options.homedir });
  let linear = options.linearTokenReference?.trim(),
    openrouter = options.openRouterTokenReference?.trim();
  const guided = !options.json && !direct && (options.stdinIsTTY ?? input.isTTY ?? false);
  if (guided && !config.linear && !env.LINEAR_API_TOKEN?.trim()) {
    write(
      `Linear API key: ${LINEAR_URL}\nSet LINEAR_API_TOKEN, or enter an op:// reference. Empty skips.\n1Password CLI: ${OP_URL}\n`,
    );
    linear = (
      await promptAnswer(options.prompt ?? defaultPrompt, "Linear 1Password reference: ")
    ).trim();
  }
  if (guided && !config.openrouter && !env.OPENROUTER_API_KEY?.trim()) {
    write(
      `OpenRouter API keys: ${OPENROUTER_URL}\nSet OPENROUTER_API_KEY, or enter an op:// reference. Empty skips.\n1Password CLI: ${OP_URL}\n`,
    );
    openrouter = (
      await promptAnswer(options.prompt ?? defaultPrompt, "OpenRouter 1Password reference: ")
    ).trim();
  }
  const staged = { ...config };
  if (linear) {
    staged.linear = { tokenReference: parseTokenReference(linear) };
    await resolveLinearToken(without(env, "LINEAR_API_TOKEN"), staged, options.runOp);
  }
  if (openrouter) {
    staged.openrouter = { tokenReference: parseTokenReference(openrouter, "OpenRouter") };
    await resolveOpenRouterKey(without(env, "OPENROUTER_API_KEY"), staged, options.runOp);
  }
  if (linear || openrouter) {
    try {
      writeMaquilaConfig(staged, { env, homedir: options.homedir });
    } catch (error) {
      throw new Error("maquila config could not be written", { cause: error });
    }
  }
  if (options.installSkill) {
    try {
      installMaquilaSkill(options.maquilaRoot, skillDestination(home));
    } catch (error) {
      if (error instanceof Error && error.message === "maquila skill destination already exists")
        throw error;
      throw new Error("maquila skill could not be installed", { cause: error });
    }
  }
  const doctor = await (options.runDoctor ?? runDoctor)({
    json: false,
    target: options.target,
    identity: options.identity,
    env,
    maquilaRoot: options.maquilaRoot,
    homedir: options.homedir,
    write: () => undefined,
  });
  const result: SetupResult = { version: 2, ok: doctor.ok, checks: doctor.checks };
  if (options.json) write(`${JSON.stringify(result)}\n`);
  else {
    for (const item of result.checks)
      write(
        `${item.id}: ${item.status} — ${item.status === "pass" ? item.message : (item.remediation ?? item.message)}\n`,
      );
    write(
      "Checks use a GitHub target read and exe.dev VM list; Linear and OpenRouter receive no authenticated probe. No vendor login, SSH mutation, or VM creation occurs.\n",
    );
  }
  return result;
}
