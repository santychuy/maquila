import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Writable } from "node:stream";
import { isAgentMode, renderAgentProgress } from "./agent-mode.js";
import {
  loadMaquilaConfig,
  parseApiToken,
  parseTokenReference,
  writeMaquilaConfig,
  type MaquilaConfig,
  type SavedCredential,
} from "./config.js";
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
  agent?: boolean;
  fromScratch?: boolean;
  linearTokenReference?: string;
  openRouterTokenReference?: string;
  installSkill?: boolean;
  maquilaRoot: string;
  stdinIsTTY?: boolean;
  prompt?: (message: string) => Promise<string>;
  promptSecret?: (message: string) => Promise<string>;
  write?: (text: string) => void;
  runOp?: CredentialRunner;
  runDoctor?: typeof runDoctor;
}

export class SetupCancelled extends Error {
  readonly code = "SIGINT";
}
export interface SetupResult extends Omit<DoctorResult, "version"> {
  version: 2;
}
function skillDestination(home: string): string {
  return resolve(home, ".pi", "agent", "skills", "maquila");
}
function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return undefined;
    throw new Error("maquila skill path could not be inspected", { cause: error });
  }
}
export function installMaquilaSkill(maquilaRoot: string, destination: string): boolean {
  const sourceDirectory = resolve(maquilaRoot, ".pi", "skills", "maquila");
  const source = resolve(sourceDirectory, "SKILL.md");
  const target = resolve(destination, "SKILL.md");
  const existing = lstatIfExists(destination);
  const legacyLink =
    existing?.isSymbolicLink() === true &&
    resolve(destination, "..", readlinkSync(destination)) === sourceDirectory;
  if (existing && !existing.isDirectory() && !legacyLink)
    throw new Error("maquila skill destination already exists");
  if (!lstatIfExists(source)?.isFile()) throw new Error("maquila skill source is unavailable");
  const content = readFileSync(source);
  // An existing link created by older setup versions is already managed. Never write through it.
  if (legacyLink) return false;
  if (existing) {
    const entries = readdirSync(destination);
    if (entries.length !== 1 || entries[0] !== "SKILL.md" || !lstatIfExists(target)?.isFile())
      throw new Error("maquila skill destination already exists");
    if (!content.equals(readFileSync(target))) throw new Error("maquila skill destination differs");
    return false;
  }
  mkdirSync(resolve(destination, ".."), { recursive: true, mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  writeFileSync(target, content, { mode: 0o600, flag: "wx" });
  return true;
}

export async function readSecret(
  message: string,
  inputStream: NodeJS.ReadableStream & {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => unknown;
  } = input,
  outputStream: NodeJS.WritableStream & { isTTY?: boolean } = output,
): Promise<string> {
  if (!inputStream.isTTY || !outputStream.isTTY)
    throw new Error("API key entry requires an interactive terminal");
  const wasRaw = Boolean(inputStream.isRaw);
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const rl = createInterface({ input: inputStream, output: muted, terminal: true, historySize: 0 });
  let cancelEnd: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    const cancel = () => reject(new SetupCancelled());
    cancelEnd = cancel;
    rl.once("SIGINT", cancel);
    rl.once("SIGTSTP", cancel);
    inputStream.once("end", cancel);
    rl.once("error", () => reject(new Error("API key input failed")));
  });
  try {
    outputStream.write(message);
    const value = await Promise.race([rl.question(""), stopped]);
    while (typeof inputStream.read === "function" && inputStream.read() !== null) {
      /* leftover paste stays secret */
    }
    return value;
  } finally {
    if (cancelEnd) inputStream.off("end", cancelEnd);
    rl.close();
    inputStream.setRawMode?.(wasRaw);
    muted.end();
    outputStream.write("\n");
  }
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
const SETUP_STEPS: Array<{ title: string; checks: string[] }> = [
  { title: "GitHub target repository", checks: ["target"] },
  { title: "GitHub access", checks: ["github"] },
  { title: "Linear credential", checks: ["linear", "workspace"] },
  { title: "OpenRouter credential and models", checks: ["openrouter", "models", "credits"] },
  { title: "exe.dev SSH", checks: ["ssh"] },
  { title: "Pi skill", checks: ["skill"] },
];
const ENV_RESTART =
  "Exporting a variable in another shell cannot change this process; restart maquila setup after export. gh auth login and op persist and can be rechecked without restart.";
function summaryLine(doctor: DoctorResult): string {
  if (doctor.ok)
    return doctor.checks.some((item) => item.status === "warn")
      ? "Setup checks passed with warnings. Review maquila doctor before starting work.\n"
      : "Setup complete. Run maquila doctor to verify a specific issue.\n";
  const failed = doctor.checks.filter((item) => item.status === "fail").map((item) => item.id);
  return `Setup incomplete: ${failed.join(", ")}. Rerun maquila setup to continue.\n`;
}
async function runSetupWizard(
  write: (text: string) => void,
  ask: (message: string) => Promise<string>,
  runSilentDoctor: () => Promise<DoctorResult>,
): Promise<DoctorResult> {
  let current = await runSilentDoctor();
  const blocked = current.checks.filter(
    (item) => (item.id === "config" || item.id === "cli") && item.status !== "pass",
  );
  if (blocked.length > 0) {
    for (const item of blocked)
      write(`${item.id}: ${item.status} — ${item.remediation ?? item.message}\n`);
    return current;
  }
  write(
    `Maquila setup — ${SETUP_STEPS.length} steps. Fix each step, then press Enter to recheck or type s to skip.\n`,
  );
  for (let index = 0; index < SETUP_STEPS.length; index++) {
    const step = SETUP_STEPS[index];
    if (!step) continue;
    for (;;) {
      const items = current.checks.filter((item) => step.checks.includes(item.id));
      const failed = items.filter((item) => item.status === "fail");
      const warnings = items.filter((item) => item.status === "warn");
      write(
        `Step ${index + 1}/${SETUP_STEPS.length}: ${step.title} — ${failed.length > 0 ? "needs attention" : "pass"}\n`,
      );
      for (const item of [...failed, ...warnings])
        write(`  ${item.id}: ${item.status} — ${item.remediation ?? item.message}\n`);
      if (failed.length === 0) break;
      const answer = (await promptAnswer(ask, "[Enter] recheck, s skip: ")).trim().toLowerCase();
      if (answer === "s" || answer === "skip") break;
      current = await runSilentDoctor();
    }
  }
  return current;
}
function without(env: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy[key];
  return copy;
}
async function chooseOption(
  ask: (message: string) => Promise<string>,
  message: string,
  valid: string[],
): Promise<string> {
  for (;;) {
    const answer = (await promptAnswer(ask, message)).trim().toLowerCase();
    if (valid.includes(answer)) return answer;
    // Re-ask on anything else; the menu stays visible above in scrollback.
  }
}
async function confirmStep(
  ask: (message: string) => Promise<string>,
  message: string,
): Promise<boolean> {
  return (await chooseOption(ask, message, ["y", "n", ""])) !== "n";
}
interface ScratchContext {
  write: (text: string) => void;
  ask: (message: string) => Promise<string>;
  askSecret: (message: string) => Promise<string>;
  installSkill?: boolean;
  env: NodeJS.ProcessEnv;
  home: string;
  maquilaRoot: string;
  target: string | undefined;
  identity: string | undefined;
  homedir: SetupOptions["homedir"];
  runOp: CredentialRunner | undefined;
  runDoctor: typeof runDoctor | undefined;
}
async function recheckStation(ctx: ScratchContext, checkId: string): Promise<boolean> {
  const notSelected = async (): Promise<never> => {
    throw new Error(`credential not selected for ${checkId} station`);
  };
  const doctor = await (ctx.runDoctor ?? runDoctor)({
    loadConfig: () => ({ version: 1 }),
    resolveLinear: notSelected,
    resolveOpenRouter: notSelected,
    ...(checkId === "github" ? { listVms: notSelected } : { resolveGithub: notSelected }),
    json: false,
    target: ctx.target,
    identity: ctx.identity,
    env: ctx.env,
    maquilaRoot: ctx.maquilaRoot,
    homedir: ctx.homedir,
    write: () => undefined,
  });
  const item = doctor.checks.find((entry) => entry.id === checkId);
  if (item?.status === "pass") {
    ctx.write(`${checkId} — pass: ${item.message}\n`);
    return true;
  }
  ctx.write(
    `${checkId} — ${item?.status ?? "missing"}: ${item?.remediation ?? item?.message ?? "check unavailable"}\n`,
  );
  return false;
}
async function credentialStation(
  ctx: ScratchContext,
  station: string,
  title: string,
  keyUrl: string,
  envVar: string,
  checkReference: (env: NodeJS.ProcessEnv, staged: MaquilaConfig) => Promise<string>,
  stage: (staged: MaquilaConfig, credential: SavedCredential) => void,
  staged: MaquilaConfig,
): Promise<"env" | "saved" | "skipped"> {
  ctx.write(`${station}: ${title}\nGet a key: ${keyUrl}\n`);
  for (;;) {
    ctx.write(
      `  1) Paste a new API key (hidden)\n  2) Use ${envVar} from the environment\n  3) Use 1Password (optional)\n  4) Skip for now\n`,
    );
    const choice = await chooseOption(ctx.ask, "Choose [1/2/3/4]: ", ["1", "2", "3", "4"]);
    if (choice === "4") return "skipped";
    if (choice === "1") {
      const value = await promptAnswer(
        ctx.askSecret,
        `${title} API key (hidden; empty goes back): `,
      );
      if (!value.trim()) continue;
      try {
        stage(staged, { token: parseApiToken(value) });
        ctx.write("Key captured without echo. API access is checked after saving.\n");
        return "saved";
      } catch {
        ctx.write("Invalid key format. Paste one key without spaces or control characters.\n");
        continue;
      }
    }
    if (choice === "2") {
      try {
        await checkReference(ctx.env, { version: 1 });
        ctx.write(`${envVar} resolves; nothing is saved.\n`);
        return "env";
      } catch {
        ctx.write(`${envVar} is unavailable in this process. ${ENV_RESTART}\n`);
        continue;
      }
    }
    const reference = (
      await promptAnswer(ctx.ask, "1Password reference (empty goes back): ")
    ).trim();
    if (!reference) continue;
    try {
      const draft: MaquilaConfig = { version: 1 };
      const credential = { tokenReference: parseTokenReference(reference, title) };
      stage(draft, credential);
      await checkReference(without(ctx.env, envVar), draft);
      stage(staged, credential);
      ctx.write("Reference resolves.\n");
      return "saved";
    } catch {
      ctx.write(
        `That reference could not be read; check it and try again. 1Password CLI: ${OP_URL}\n`,
      );
    }
  }
}
async function persistStation(ctx: ScratchContext, checkId: string): Promise<boolean> {
  for (;;) {
    ctx.write("  1) Recheck now\n  2) Skip for now\n");
    const choice = await chooseOption(ctx.ask, "Choose [1/2]: ", ["1", "2"]);
    if (choice === "2") return false;
    if (await recheckStation(ctx, checkId)) return true;
    ctx.write(`${ENV_RESTART}\n`);
  }
}
async function runFromScratch(ctx: ScratchContext): Promise<SetupResult> {
  const staged: MaquilaConfig = { version: 1 };
  const existing = loadMaquilaConfig({ env: ctx.env, homedir: ctx.homedir });
  ctx.write(
    "Maquila setup from scratch — 5 stations. Nothing is assumed; existing credentials count only when you choose them.\n",
  );
  ctx.write(
    "Station 1/5: GitHub\nLog in with: gh auth login --web --hostname github.com\nOr export GITHUB_TOKEN: https://github.com/settings/personal-access-tokens/new\n",
  );
  const githubChosen = await persistStation(ctx, "github");
  const linear = await credentialStation(
    ctx,
    "Station 2/5",
    "Linear",
    LINEAR_URL,
    "LINEAR_API_TOKEN",
    (env, draft) => resolveLinearToken(env, draft, ctx.runOp),
    (draft, credential) => {
      draft.linear = credential;
    },
    staged,
  );
  const openrouter = await credentialStation(
    ctx,
    "Station 3/5",
    "OpenRouter",
    OPENROUTER_URL,
    "OPENROUTER_API_KEY",
    (env, draft) => resolveOpenRouterKey(env, draft, ctx.runOp),
    (draft, credential) => {
      draft.openrouter = credential;
    },
    staged,
  );
  const skipped = [
    githubChosen ? undefined : "GitHub",
    linear === "skipped" ? "Linear" : undefined,
    openrouter === "skipped" ? "OpenRouter" : undefined,
  ].filter((name): name is string => Boolean(name));
  ctx.write(
    `Station 4/5: exe.dev SSH — no API key\nCheck existing access: ssh exe.dev whoami\nNew account: follow https://exe.dev/docs/cli-ssh-key, then ssh exe.dev to register.\nCreate a dedicated SSH key only at an unused path; never overwrite an existing key.\nKeep the private key on this computer. Register only its public key.\nUse --identity /absolute/key or MAQUILA_EXE_IDENTITY when needed; load passphrased keys with ssh-add.\nSetup does not create keys, change SSH config, or create a VM.\n`,
  );
  const sshChosen = await persistStation(ctx, "ssh");
  if (!sshChosen) skipped.push("exe.dev SSH");
  ctx.write("Station 5/5: Pi skill\n");
  if (
    ctx.installSkill ||
    (await confirmStep(ctx.ask, "Install the user-scope Pi skill? [Y/n]: "))
  ) {
    try {
      const installed = installMaquilaSkill(ctx.maquilaRoot, skillDestination(ctx.home));
      ctx.write(installed ? "Skill installed.\n" : "Skill already installed.\n");
    } catch (error) {
      throw new Error("maquila skill could not be installed", { cause: error });
    }
  }
  const credentials = (staged.linear ? 1 : 0) + (staged.openrouter ? 1 : 0);
  const containsKeys = [staged.linear, staged.openrouter].some(
    (value) => value && "token" in value,
  );
  if (containsKeys)
    ctx.write(
      "Keys will be stored unencrypted in your host Maquila config, outside the project by default. Directory 0700, file 0600: other processes running as you can still read it. Never share or commit this file.\n",
    );
  let referencesSaved = credentials === 0;
  if (
    credentials > 0 &&
    (await confirmStep(ctx.ask, `Save ${credentials} credential(s) to the maquila config? [Y/n]: `))
  ) {
    try {
      writeMaquilaConfig(
        {
          version: 1,
          linear: staged.linear ?? existing.linear,
          openrouter: staged.openrouter ?? existing.openrouter,
        },
        { env: ctx.env, homedir: ctx.homedir, target: ctx.target },
      );
      referencesSaved = true;
    } catch (error) {
      throw new Error("maquila config could not be written", { cause: error });
    }
  }
  if (!referencesSaved) ctx.write("Credentials not saved; setup remains incomplete.\n");
  const doctorEnv = { ...ctx.env };
  if (linear !== "env") delete doctorEnv.LINEAR_API_TOKEN;
  if (openrouter !== "env") delete doctorEnv.OPENROUTER_API_KEY;
  if (!githubChosen) {
    delete doctorEnv.GITHUB_TOKEN;
    delete doctorEnv.GH_TOKEN;
  }
  if (!sshChosen) delete doctorEnv.MAQUILA_EXE_IDENTITY;
  const chosenConfig: MaquilaConfig = {
    version: 1,
    ...(referencesSaved && staged.linear ? { linear: staged.linear } : {}),
    ...(referencesSaved && staged.openrouter ? { openrouter: staged.openrouter } : {}),
  };
  const doctor = await (ctx.runDoctor ?? runDoctor)({
    json: false,
    target: ctx.target,
    identity: ctx.identity,
    env: doctorEnv,
    maquilaRoot: ctx.maquilaRoot,
    homedir: ctx.homedir,
    loadConfig: () => chosenConfig,
    ...(githubChosen
      ? {}
      : {
          resolveGithub: async () => {
            throw new Error("GitHub skipped");
          },
        }),
    ...(sshChosen
      ? {}
      : {
          listVms: async () => {
            throw new Error("exe.dev SSH skipped");
          },
        }),
    write: () => undefined,
  });
  if (skipped.length > 0)
    ctx.write(
      `Skipped stations: ${skipped.join(", ")}. Rerun maquila setup --from-scratch to fill them.\n`,
    );
  for (const item of doctor.checks)
    if (item.status !== "pass" || item.id === "workspace" || item.id === "credits") {
      ctx.write(`${item.id}: ${item.status} — ${item.message}\n`);
      if (item.remediation) ctx.write(`  ${item.remediation}\n`);
    }
  ctx.write(summaryLine(doctor));
  return { ...doctor, version: 2 };
}
export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const env = options.env ?? process.env,
    write = options.write ?? ((text) => process.stdout.write(text));
  const target = options.target ?? process.cwd();
  const home = (options.homedir ?? defaultHomedir)(),
    tokenFlags =
      options.linearTokenReference !== undefined || options.openRouterTokenReference !== undefined;
  let config = loadMaquilaConfig({ env, homedir: options.homedir });
  let linear = options.linearTokenReference?.trim(),
    openrouter = options.openRouterTokenReference?.trim();
  const agentMode = isAgentMode(options.agent, env);
  const tty = options.stdinIsTTY ?? input.isTTY ?? false;
  const machine = options.json === true || agentMode;
  const missingCredentials =
    (!config.linear && !env.LINEAR_API_TOKEN?.trim()) ||
    (!config.openrouter && !env.OPENROUTER_API_KEY?.trim());
  if (options.fromScratch || (tty && !machine && !tokenFlags && missingCredentials)) {
    if (!tty) throw new Error("--from-scratch requires an interactive terminal");
    return runFromScratch({
      write,
      ask: options.prompt ?? defaultPrompt,
      askSecret: options.promptSecret ?? readSecret,
      installSkill: options.installSkill,
      env,
      home,
      maquilaRoot: options.maquilaRoot,
      target,
      identity: options.identity,
      homedir: options.homedir,
      runOp: options.runOp,
      runDoctor: options.runDoctor,
    });
  }
  const wizard = tty && !machine && !tokenFlags;
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
      writeMaquilaConfig(staged, { env, homedir: options.homedir, target });
    } catch (error) {
      throw new Error("maquila config could not be written", { cause: error });
    }
  }
  if (options.installSkill) {
    try {
      installMaquilaSkill(options.maquilaRoot, skillDestination(home));
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "maquila skill destination already exists" ||
          error.message === "maquila skill destination differs")
      )
        throw error;
      throw new Error("maquila skill could not be installed", { cause: error });
    }
  }
  const runSilentDoctor = (): Promise<DoctorResult> =>
    (options.runDoctor ?? runDoctor)({
      json: false,
      target,
      identity: options.identity,
      env,
      maquilaRoot: options.maquilaRoot,
      homedir: options.homedir,
      write: () => undefined,
    });
  const ask = options.prompt ?? defaultPrompt;
  const doctor = wizard
    ? await runSetupWizard(write, ask, runSilentDoctor)
    : await runSilentDoctor();
  const result: SetupResult = { ...doctor, version: 2 };
  if (options.json) write(`${JSON.stringify(result)}\n`);
  else if (agentMode) write(renderAgentProgress(doctor));
  else if (wizard) write(summaryLine(doctor));
  else {
    for (const item of result.checks)
      write(
        `${item.id}: ${item.status} — ${item.status === "pass" ? item.message : (item.remediation ?? item.message)}\n`,
      );
    write(
      "Checks read GitHub target access, Linear identity, OpenRouter key limits, and the exe.dev VM list. No vendor login, inference request, SSH mutation, or VM creation occurs.\n",
    );
  }
  return result;
}
