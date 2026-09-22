import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { BUN_VERSION, NODE_CHECKSUMS, NODE_VERSION, REMOTE_PATH } from "./controller.js";
import type { ControllerCredentials } from "./credentials.js";
import { externalCommandEnvironment, ExeClient, assertExeVmName } from "./integrations/exe.js";
import {
  createLinearAutomaticWebhook,
  deleteLinearAutomaticWebhook,
  fetchSingleLinearTeamId,
  listLinearAutomaticWebhooks,
} from "./integrations/linear.js";
import {
  type IntakeControllerState,
  readIntakeControllerState,
  writeIntakeControllerState,
} from "./intake-controller-state.js";
import { archiveMaquila, runtimeArchiveSha256 } from "./runtime-archive.js";
import type { TargetRepository } from "./target.js";

const REMOTE_HOME = "/home/exedev";
const REMOTE_TARGET = `${REMOTE_HOME}/maquila-target`;
const REMOTE_PACKAGE = `${REMOTE_HOME}/maquila-controller.tgz`;
const REMOTE_PREFIX = `${REMOTE_HOME}/.local/maquila`;
const REMOTE_CLI = `${REMOTE_PREFIX}/bin/maquila`;
const REMOTE_IDENTITY = `${REMOTE_HOME}/.ssh/maquila-controller`;
const REMOTE_ENV = `${REMOTE_HOME}/.config/maquila/intake.env`;
const REMOTE_UNIT = `${REMOTE_HOME}/.config/systemd/user/maquila-intake.service`;
const REMOTE_EXPIRY_UNIT = `${REMOTE_HOME}/.config/systemd/user/maquila-intake-expiry.service`;
const REMOTE_EXPIRY_TIMER = `${REMOTE_HOME}/.config/systemd/user/maquila-intake-expiry.timer`;
const REMOTE_GIT_CREDENTIALS = `${REMOTE_HOME}/.config/maquila/git-credentials`;
const REMOTE_STATE = `${REMOTE_HOME}/.local/state/maquila/.maquila/intake-controller.json`;
const SERVICE_NAME = "maquila-intake.service";
const EXPIRY_TIMER_NAME = "maquila-intake-expiry.timer";

export interface ControllerPackage {
  path: string;
  sha256: string;
  sourceSha: string;
  sourceDirty: boolean;
  cleanup(): void;
}

function command(root: string, file: string, args: string[]): string {
  return execFileSync(file, args, {
    cwd: root,
    env: externalCommandEnvironment(process.env),
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 2_000_000,
  }).trim();
}

export function buildIntakeControllerPackage(codeRoot: string): ControllerPackage {
  const root = resolve(codeRoot);
  const directory = mkdtempSync(resolve(tmpdir(), "maquila-controller-package-"));
  try {
    const sourceSha = command(root, "git", ["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("Maquila source SHA is invalid");
    const sourceDirty = command(root, "git", ["status", "--porcelain", "--untracked-files=all"])
      .split("\n")
      .some(Boolean);
    command(root, "bun", ["run", "build:observer"]);
    command(root, "bun", ["run", "build:js"]);
    const runtime = archiveMaquila(root);
    try {
      if (runtime.sha !== sourceSha) throw new Error("controller runtime source mismatch");
      const output = resolve(root, "dist/runtime");
      mkdirSync(output, { recursive: true });
      copyFileSync(runtime.path, resolve(output, "runtime.tar"));
      writeFileSync(
        resolve(output, "runtime.json"),
        `${JSON.stringify({ version: 1, maquilaSha: runtime.sha, sha256: runtimeArchiveSha256(runtime) }, null, 2)}\n`,
      );
    } finally {
      runtime.cleanup();
    }
    command(root, "npm", ["pack", "--ignore-scripts", "--pack-destination", directory]);
    const packages = readdirSync(directory).filter((name) => name.endsWith(".tgz"));
    if (packages.length !== 1) throw new Error("Maquila package build is ambiguous");
    const path = resolve(directory, packages[0]!);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > 100 * 1024 * 1024)
      throw new Error("Maquila package build is invalid");
    chmodSync(path, 0o600);
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    return {
      path,
      sha256,
      sourceSha,
      sourceDirty,
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function secretFile(directory: string, name: string, content: string): string {
  const path = resolve(directory, name);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function environmentValue(value: string): string {
  if (!value || value.includes("\0") || /[\r\n]/.test(value))
    throw new Error("controller environment value is invalid");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function serviceEnvironment(input: {
  credentials: ControllerCredentials;
  publicUrl: string;
  webhookSecret: string;
}): string {
  const values: Record<string, string> = {
    HOME: REMOTE_HOME,
    PATH: `${REMOTE_PREFIX}/bin:${REMOTE_PATH}`,
    MAQUILA_HOME: `${REMOTE_HOME}/.local/state/maquila`,
    MAQUILA_PUBLIC_URL: input.publicUrl,
    MAQUILA_LINEAR_WEBHOOK_SECRET: input.webhookSecret,
    MAQUILA_EXE_IDENTITY: REMOTE_IDENTITY,
    LINEAR_API_TOKEN: input.credentials.linearToken,
    GITHUB_TOKEN: input.credentials.githubToken,
    OPENROUTER_API_KEY: input.credentials.openRouterKey,
  };
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${environmentValue(value)}`)
    .join("\n")}\n`;
}

function serviceUnit(port: number): string {
  return `[Unit]\nDescription=Maquila automatic Linear intake\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironmentFile=%h/.config/maquila/intake.env\nExecStart=${REMOTE_CLI} intake serve --target ${REMOTE_TARGET} --port ${port}\nRestart=on-failure\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`;
}

function expiryServiceUnit(): string {
  return `[Unit]\nDescription=Expire Maquila intake controller\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nEnvironmentFile=%h/.config/maquila/intake.env\nExecStart=${REMOTE_CLI} intake expire\nRestart=on-failure\nRestartSec=300\n`;
}

function expiryTimerUnit(expiresAt: string): string {
  const calendar = `${expiresAt.slice(0, 19).replace("T", " ")} UTC`;
  return `[Unit]\nDescription=Expire Maquila intake controller at ${expiresAt}\n\n[Timer]\nOnCalendar=${calendar}\nPersistent=true\nUnit=maquila-intake-expiry.service\n\n[Install]\nWantedBy=timers.target\n`;
}

async function waitForSsh(
  exe: ExeClient,
  destination: string,
  sleep: (ms: number) => Promise<void>,
) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await exe.exec(destination, ["true"], 30_000);
      return;
    } catch (error) {
      if (attempt === 11) throw error;
      await sleep(5_000);
    }
  }
}

async function bootstrapRuntime(exe: ExeClient, destination: string): Promise<void> {
  const machine = (await exe.exec(destination, ["uname", "-m"], 30_000)).stdout.trim();
  const arch = machine === "x86_64" ? "x64" : machine === "aarch64" ? "arm64" : "";
  const checksum = NODE_CHECKSUMS[arch];
  if (!checksum) throw new Error("unsupported controller VM architecture");
  const archive = `${REMOTE_HOME}/node-v${NODE_VERSION}-linux-${arch}.tar.xz`;
  await exe.exec(
    destination,
    [
      "mkdir",
      "-p",
      `${REMOTE_HOME}/.local/node`,
      `${REMOTE_HOME}/.local/bun`,
      REMOTE_PREFIX,
      `${REMOTE_HOME}/.ssh`,
      `${REMOTE_HOME}/.config/maquila`,
      `${REMOTE_HOME}/.config/systemd/user`,
      `${REMOTE_HOME}/.local/state/maquila/.maquila`,
    ],
    30_000,
  );
  await exe.exec(
    destination,
    [
      "curl",
      "-fsSLo",
      archive,
      `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz`,
    ],
    120_000,
  );
  const actual = (await exe.exec(destination, ["sha256sum", archive], 30_000)).stdout
    .trim()
    .split(/\s+/, 1)[0];
  if (actual !== checksum) throw new Error("controller Node.js checksum mismatch");
  await exe.exec(
    destination,
    ["tar", "-xJf", archive, "-C", `${REMOTE_HOME}/.local/node`, "--strip-components=1"],
    60_000,
  );
  await exe.exec(
    destination,
    [
      "env",
      `PATH=${REMOTE_PATH}`,
      `${REMOTE_HOME}/.local/node/bin/npm`,
      "install",
      "--global",
      "--prefix",
      `${REMOTE_HOME}/.local/bun`,
      `bun@${BUN_VERSION}`,
    ],
    180_000,
  );
  const bun = (
    await exe.exec(destination, [`${REMOTE_HOME}/.local/bun/bin/bun`, "--version"], 30_000)
  ).stdout.trim();
  if (bun !== BUN_VERSION) throw new Error("controller Bun version mismatch");
}

async function userServiceCommand(
  exe: ExeClient,
  destination: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const uid = (await exe.exec(destination, ["id", "-u"], 30_000)).stdout.trim();
  if (!/^\d{1,10}$/.test(uid)) throw new Error("controller VM user identity is invalid");
  return exe.exec(
    destination,
    ["env", `XDG_RUNTIME_DIR=/run/user/${uid}`, "systemctl", "--user", ...args],
    30_000,
  );
}

async function waitForPublicGateway(
  url: string,
  fetcher: typeof globalThis.fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetcher(new URL("/__maquila_ready", url), {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 404) return;
    } catch {
      // Proxy and service can take a few seconds to converge.
    }
    if (attempt < 19) await sleep(3_000);
  }
  throw new Error("controller gateway did not become reachable");
}

export interface DeployIntakeControllerOptions {
  codeRoot: string;
  statePath: string;
  target: TargetRepository;
  credentials: ControllerCredentials;
  vmName: string;
  port: number;
  ttlSeconds?: number;
  exe?: ExeClient;
  package?: ControllerPackage;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  createWebhook?: typeof createLinearAutomaticWebhook;
  deleteWebhook?: typeof deleteLinearAutomaticWebhook;
  listWebhooks?: typeof listLinearAutomaticWebhooks;
  resolveTeamId?: typeof fetchSingleLinearTeamId;
}

export async function deployIntakeController(
  options: DeployIntakeControllerOptions,
): Promise<IntakeControllerState> {
  const vmName = assertExeVmName(options.vmName);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535)
    throw new Error("controller port is invalid");
  if (
    options.ttlSeconds !== undefined &&
    (!Number.isSafeInteger(options.ttlSeconds) ||
      options.ttlSeconds < 60 ||
      options.ttlSeconds > 365 * 24 * 60 * 60)
  )
    throw new Error("controller TTL must be between 1 minute and 365 days");
  const now = options.now ?? Date.now;
  const exe = options.exe ?? new ExeClient(undefined, 30_000, options.credentials.identity);
  let previous = readIntakeControllerState(options.statePath);
  if (previous?.status === "running") {
    if (previous.expiresAt && now() >= Date.parse(previous.expiresAt))
      previous = await destroyIntakeController({
        statePath: options.statePath,
        credentials: options.credentials,
        exe,
        deleteWebhook: options.deleteWebhook,
        listWebhooks: options.listWebhooks,
        now,
      });
    else {
      const requestedExpiry =
        options.ttlSeconds === undefined
          ? undefined
          : new Date(Date.parse(previous.createdAt) + options.ttlSeconds * 1000).toISOString();
      if (
        previous.vmName !== vmName ||
        previous.port !== options.port ||
        previous.targetFullName !== `${options.target.owner}/${options.target.repo}` ||
        previous.targetBaseRef !== options.target.baseRef ||
        previous.expiresAt !== requestedExpiry
      )
        throw new Error("running intake controller does not match requested deployment");
      return previous;
    }
  }
  if (previous && previous.status !== "destroyed")
    await destroyIntakeController({
      statePath: options.statePath,
      credentials: options.credentials,
      exe,
      deleteWebhook: options.deleteWebhook,
      listWebhooks: options.listWebhooks,
      now,
    });
  const built = options.package ?? buildIntakeControllerPackage(options.codeRoot);
  const sleep =
    options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const temporary = mkdtempSync(resolve(tmpdir(), "maquila-controller-secrets-"));
  const deploymentId = randomUUID();
  const createdAt = new Date(now()).toISOString();
  const expiresAt =
    options.ttlSeconds === undefined
      ? undefined
      : new Date(Date.parse(createdAt) + options.ttlSeconds * 1000).toISOString();
  const publicUrl = `https://${vmName}.exe.xyz`;
  const webhookUrl = new URL("/hooks/linear", publicUrl).href;
  const webhookSecret = randomBytes(32).toString("hex");
  const label = `Maquila ${deploymentId}`;
  let state: IntakeControllerState | undefined;
  let checkpoint = "local preparation";
  try {
    const envPath = secretFile(
      temporary,
      "intake.env",
      serviceEnvironment({ credentials: options.credentials, publicUrl, webhookSecret }),
    );
    const unitPath = secretFile(temporary, "maquila-intake.service", serviceUnit(options.port));
    const credentialUrl = `https://x-access-token:${encodeURIComponent(
      options.credentials.githubToken,
    )}@github.com`;
    const gitCredentialsPath = secretFile(temporary, "git-credentials", `${credentialUrl}\n`);
    state = {
      version: 1,
      deploymentId,
      status: "provisioning",
      vmName,
      sshDest: `${vmName}.exe.xyz`,
      publicUrl,
      port: options.port,
      targetFullName: `${options.target.owner}/${options.target.repo}`,
      targetBaseRef: options.target.baseRef,
      sourceSha: built.sourceSha,
      sourceDirty: built.sourceDirty,
      packageSha256: built.sha256,
      bootPersistent: false,
      ...(expiresAt ? { expiresAt } : {}),
      createdAt,
      updatedAt: createdAt,
    };
    writeIntakeControllerState(options.statePath, state);
    checkpoint = "VM creation";
    const vm = await exe.createVm({ name: vmName, tag: "maquila-controller" });
    if (vm.sshDest !== state.sshDest) throw new Error("controller VM destination mismatch");
    checkpoint = "VM readiness";
    await waitForSsh(exe, vm.sshDest, sleep);
    checkpoint = "runtime bootstrap";
    await bootstrapRuntime(exe, vm.sshDest);
    checkpoint = "package installation";
    await exe.copyTo(vm.sshDest, built.path, REMOTE_PACKAGE);
    await exe.exec(
      vm.sshDest,
      [
        "env",
        `PATH=${REMOTE_PATH}`,
        `${REMOTE_HOME}/.local/node/bin/npm`,
        "install",
        "--global",
        "--prefix",
        REMOTE_PREFIX,
        "--ignore-scripts",
        REMOTE_PACKAGE,
      ],
      300_000,
    );
    await exe.exec(
      vm.sshDest,
      ["env", `PATH=${REMOTE_PREFIX}/bin:${REMOTE_PATH}`, REMOTE_CLI, "--help"],
      30_000,
    );
    checkpoint = "controller identity registration";
    await exe.exec(
      vm.sshDest,
      [
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        `maquila-${deploymentId}`,
        "-f",
        REMOTE_IDENTITY,
      ],
      30_000,
    );
    const publicKey = (
      await exe.exec(vm.sshDest, ["cat", `${REMOTE_IDENTITY}.pub`], 30_000)
    ).stdout.trim();
    state = { ...state, controllerPublicKey: publicKey, updatedAt: new Date(now()).toISOString() };
    writeIntakeControllerState(options.statePath, state);
    await exe.addSshKey(publicKey, options.target.tag);
    checkpoint = "controller identity verification";
    await exe.exec(
      vm.sshDest,
      [
        "ssh",
        "-i",
        REMOTE_IDENTITY,
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ForwardAgent=no",
        "exe.dev",
        "ls",
        "--json",
      ],
      30_000,
    );
    checkpoint = "target checkout";
    await exe.copyTo(vm.sshDest, gitCredentialsPath, REMOTE_GIT_CREDENTIALS);
    await exe.exec(vm.sshDest, ["chmod", "600", REMOTE_GIT_CREDENTIALS], 30_000);
    await exe.exec(
      vm.sshDest,
      [
        "git",
        "-c",
        `credential.helper=store --file=${REMOTE_GIT_CREDENTIALS}`,
        "clone",
        "--branch",
        options.target.baseRef,
        "--single-branch",
        `https://github.com/${options.target.owner}/${options.target.repo}.git`,
        REMOTE_TARGET,
      ],
      180_000,
    );
    await exe.exec(vm.sshDest, ["rm", "-f", REMOTE_GIT_CREDENTIALS], 30_000);
    checkpoint = "service installation";
    await exe.copyTo(vm.sshDest, envPath, REMOTE_ENV);
    await exe.copyTo(vm.sshDest, unitPath, REMOTE_UNIT);
    await exe.exec(vm.sshDest, ["chmod", "600", REMOTE_ENV, REMOTE_UNIT, REMOTE_IDENTITY], 30_000);
    checkpoint = "boot persistence";
    await exe.exec(vm.sshDest, ["sudo", "-n", "loginctl", "enable-linger", "exedev"], 30_000);
    checkpoint = "service manager reload";
    await userServiceCommand(exe, vm.sshDest, ["daemon-reload"]);
    checkpoint = "service enable";
    await userServiceCommand(exe, vm.sshDest, ["enable", "--now", SERVICE_NAME]);
    checkpoint = "service health check";
    const active = (
      await userServiceCommand(exe, vm.sshDest, [
        "show",
        SERVICE_NAME,
        "--property=ActiveState",
        "--value",
      ])
    ).stdout.trim();
    if (active !== "active") {
      checkpoint = `service health check (${active || "unknown"})`;
      throw new Error("controller intake service is not active");
    }
    state = { ...state, bootPersistent: true, updatedAt: new Date(now()).toISOString() };
    writeIntakeControllerState(options.statePath, state);
    checkpoint = "public proxy";
    await exe.configurePublicProxy(vmName, options.port);
    await waitForPublicGateway(publicUrl, options.fetch ?? globalThis.fetch, sleep);
    checkpoint = "Linear webhook";
    const teamId = await (options.resolveTeamId ?? fetchSingleLinearTeamId)({
      token: options.credentials.linearToken,
    });
    const webhook = await (options.createWebhook ?? createLinearAutomaticWebhook)({
      token: options.credentials.linearToken,
      url: webhookUrl,
      secret: webhookSecret,
      label,
      teamId,
    });
    state = {
      ...state,
      linearWebhookId: webhook.id,
      updatedAt: new Date(now()).toISOString(),
    };
    writeIntakeControllerState(options.statePath, state);
    state = { ...state, status: "running", updatedAt: new Date(now()).toISOString() };
    writeIntakeControllerState(options.statePath, state);
    if (state.expiresAt) {
      checkpoint = "expiry installation";
      const expiryUnitPath = secretFile(
        temporary,
        "maquila-intake-expiry.service",
        expiryServiceUnit(),
      );
      const expiryTimerPath = secretFile(
        temporary,
        "maquila-intake-expiry.timer",
        expiryTimerUnit(state.expiresAt),
      );
      await exe.copyTo(vm.sshDest, options.statePath, REMOTE_STATE);
      await exe.copyTo(vm.sshDest, expiryUnitPath, REMOTE_EXPIRY_UNIT);
      await exe.copyTo(vm.sshDest, expiryTimerPath, REMOTE_EXPIRY_TIMER);
      await exe.exec(
        vm.sshDest,
        ["chmod", "600", REMOTE_STATE, REMOTE_EXPIRY_UNIT, REMOTE_EXPIRY_TIMER],
        30_000,
      );
      await userServiceCommand(exe, vm.sshDest, ["daemon-reload"]);
      await userServiceCommand(exe, vm.sshDest, ["enable", "--now", EXPIRY_TIMER_NAME]);
      const timerActive = (
        await userServiceCommand(exe, vm.sshDest, [
          "show",
          EXPIRY_TIMER_NAME,
          "--property=ActiveState",
          "--value",
        ])
      ).stdout.trim();
      if (timerActive !== "active") {
        checkpoint = `expiry timer health check (${timerActive || "unknown"})`;
        throw new Error("controller expiry timer is not active");
      }
    }
    return state;
  } catch (error) {
    if (state)
      try {
        await destroyIntakeController({
          statePath: options.statePath,
          credentials: options.credentials,
          exe,
          deleteWebhook: options.deleteWebhook,
          listWebhooks: options.listWebhooks,
          now,
        });
      } catch {
        // destroyIntakeController persists cleanup_pending.
      }
    throw new Error(`controller deployment failed during ${checkpoint}`, { cause: error });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    if (!options.package) built.cleanup();
  }
}

export async function destroyIntakeController(options: {
  statePath: string;
  credentials: ControllerCredentials;
  exe?: ExeClient;
  now?: () => number;
  deleteWebhook?: typeof deleteLinearAutomaticWebhook;
  listWebhooks?: typeof listLinearAutomaticWebhooks;
  selfDestruct?: boolean;
}): Promise<IntakeControllerState | undefined> {
  let state = readIntakeControllerState(options.statePath);
  if (!state || state.status === "destroyed") return state;
  const exe = options.exe ?? new ExeClient(undefined, 30_000, options.credentials.identity);
  const now = options.now ?? Date.now;
  let failed = false;
  let vmExists: boolean | undefined;
  try {
    vmExists = (await exe.listVms()).some((vm) => vm.vmName === state!.vmName);
  } catch {
    failed = true;
  }
  if (vmExists !== false) {
    try {
      await exe.makeProxyPrivate(state.vmName);
    } catch {
      // VM destruction is authoritative for proxy removal.
    }
    try {
      await userServiceCommand(exe, state.sshDest, ["disable", "--now", SERVICE_NAME]);
    } catch {
      // VM destruction is authoritative for service shutdown.
    }
    try {
      await exe.exec(
        state.sshDest,
        [
          "rm",
          "-f",
          REMOTE_GIT_CREDENTIALS,
          ...(options.selfDestruct ? [] : [REMOTE_ENV, REMOTE_IDENTITY, `${REMOTE_IDENTITY}.pub`]),
        ],
        30_000,
      );
    } catch {
      // Registered key is revoked below; VM destruction removes remaining files.
    }
  }
  try {
    const listWebhooks = options.listWebhooks ?? listLinearAutomaticWebhooks;
    const deleteWebhook = options.deleteWebhook ?? deleteLinearAutomaticWebhook;
    const webhookId = state.linearWebhookId;
    if (webhookId)
      try {
        await deleteWebhook({ token: options.credentials.linearToken, id: webhookId });
      } catch (error) {
        const remaining = await listWebhooks({ token: options.credentials.linearToken });
        if (remaining.some((webhook) => webhook.id === webhookId)) throw error;
      }
    else {
      const label = `Maquila ${state.deploymentId}`;
      const url = new URL("/hooks/linear", state.publicUrl).href;
      const webhookIds = (await listWebhooks({ token: options.credentials.linearToken }))
        .filter((webhook) => webhook.label === label && webhook.url === url)
        .map((webhook) => webhook.id);
      if (webhookIds.length > 1) throw new Error("Linear automatic webhook is ambiguous");
      for (const id of webhookIds)
        await deleteWebhook({ token: options.credentials.linearToken, id });
    }
    if (state.linearWebhookId) {
      const { linearWebhookId: _removed, ...withoutWebhook } = state;
      state = { ...withoutWebhook, updatedAt: new Date(now()).toISOString() };
      writeIntakeControllerState(options.statePath, state);
    }
  } catch {
    failed = true;
  }
  if (options.selfDestruct && failed) {
    state = {
      ...state,
      status: "cleanup_pending",
      updatedAt: new Date(now()).toISOString(),
    };
    writeIntakeControllerState(options.statePath, state);
    throw new Error("intake controller cleanup is incomplete");
  }
  if (options.selfDestruct) {
    if (!state.controllerPublicKey) failed = true;
    else
      try {
        await exe.destroyVmFromWithin(state.vmName, state.controllerPublicKey);
      } catch {
        failed = true;
      }
  } else {
    if (state.controllerPublicKey)
      try {
        if (await exe.hasSshKey(state.controllerPublicKey))
          await exe.removeSshKey(state.controllerPublicKey);
        const { controllerPublicKey: _removed, ...withoutKey } = state;
        state = { ...withoutKey, updatedAt: new Date(now()).toISOString() };
        writeIntakeControllerState(options.statePath, state);
      } catch {
        failed = true;
      }
    try {
      await exe.destroyVm(state.vmName);
    } catch {
      failed = true;
    }
  }
  state = {
    ...state,
    status: failed ? "cleanup_pending" : "destroyed",
    updatedAt: new Date(now()).toISOString(),
  };
  writeIntakeControllerState(options.statePath, state);
  if (failed) throw new Error("intake controller cleanup is incomplete");
  return state;
}

export async function expireIntakeController(options: {
  statePath: string;
  credentials: ControllerCredentials;
  exe?: ExeClient;
  now?: () => number;
  deleteWebhook?: typeof deleteLinearAutomaticWebhook;
  listWebhooks?: typeof listLinearAutomaticWebhooks;
}): Promise<IntakeControllerState> {
  const state = readIntakeControllerState(options.statePath);
  if (!state?.expiresAt) throw new Error("intake controller has no expiration");
  const now = options.now ?? Date.now;
  if (now() < Date.parse(state.expiresAt)) throw new Error("intake controller TTL has not expired");
  const result = await destroyIntakeController({ ...options, now, selfDestruct: true });
  if (!result) throw new Error("intake controller state is absent");
  return result;
}

export async function statusIntakeController(options: {
  statePath: string;
  identity?: string;
  exe?: ExeClient;
  now?: () => number;
}): Promise<{
  state?: IntakeControllerState;
  vm: "absent" | "running" | "unknown";
  service: "absent" | "active" | "inactive" | "unknown";
  expired: boolean;
}> {
  const state = readIntakeControllerState(options.statePath);
  if (!state) return { vm: "absent", service: "absent", expired: false };
  const expired = Boolean(
    state.expiresAt && (options.now ?? Date.now)() >= Date.parse(state.expiresAt),
  );
  if (state.status === "destroyed") return { state, vm: "absent", service: "absent", expired };
  const exe = options.exe ?? new ExeClient(undefined, 30_000, options.identity);
  try {
    const exists = (await exe.listVms()).some((vm) => vm.vmName === state.vmName);
    if (!exists) return { state, vm: "absent", service: "absent", expired };
    try {
      const service = (
        await userServiceCommand(exe, state.sshDest, ["is-active", SERVICE_NAME])
      ).stdout.trim();
      return {
        state,
        vm: "running",
        service: service === "active" ? "active" : "inactive",
        expired,
      };
    } catch {
      return { state, vm: "running", service: "unknown", expired };
    }
  } catch {
    return { state, vm: "unknown", service: "unknown", expired };
  }
}

export function controllerPackageBasename(value: ControllerPackage): string {
  return basename(value.path);
}
