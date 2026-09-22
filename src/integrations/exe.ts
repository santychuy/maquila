import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SAFE_VM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{40,120}={0,3}(?: [A-Za-z0-9._:@+-]{1,128})?$/;

export function assertExeVmName(value: unknown): string {
  if (typeof value !== "string" || !SAFE_VM_NAME.test(value)) throw new Error("invalid VM name");
  return value;
}
/** Built-in exe.dev tag boundary from observed provider error: must match ^[a-z][a-z0-9_-]*$. */
export const EXE_TAG_PATTERN = /^[a-z][a-z0-9_-]*$/;
export const EXE_TAG_MAX_LENGTH = 64;

export function assertExeTag(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid tag");
  if (value.length > EXE_TAG_MAX_LENGTH || !EXE_TAG_PATTERN.test(value))
    throw new Error(
      `invalid tag "${value}": exe.dev tags must match ^[a-z][a-z0-9_-]*$ (1-64 chars)`,
    );
  return value;
}
const SAFE_DESTINATION = /^(?:[A-Za-z0-9._+-]+@)?[A-Za-z0-9.-]+$/;
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=2",
  "-o",
  "HostKeyAlias=exe.dev",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "UpdateHostKeys=no",
  "-o",
  "ForwardAgent=no",
];

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeout: number;
  env: NodeJS.ProcessEnv;
}

const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "MAQUILA_HOME",
  "XDG_STATE_HOME",
] as const;

export function externalCommandEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    SAFE_ENV_KEYS.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])),
  );
}

export function sshCommandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = externalCommandEnvironment(source);
  const sock = source.SSH_AUTH_SOCK;
  if (sock === undefined) return env;
  if (sock.includes("\0") || !sock.trim()) throw new Error("SSH_AUTH_SOCK is invalid");
  return { ...env, SSH_AUTH_SOCK: sock };
}

export type ExeRunner = (file: string, args: string[], options: RunOptions) => Promise<ExecResult>;
export type ExeStreamRunner = (
  file: string,
  args: string[],
  options: RunOptions,
  onStdout: (chunk: Buffer) => void,
) => Promise<{ stderr: string }>;

export interface ExeVm {
  vmName: string;
  status: string;
  sshDest: string;
  sshHost?: string;
  sshUser?: string;
}

// ponytail: allowlisted create-VM rejection codes only; no raw provider output ever leaves this module.
export type ExeCreateVmReason =
  | "invalid-tag"
  | "unknown-image"
  | "name-taken"
  | "quota-exceeded"
  | "team-pool-required"
  | "integration-required"
  | "unclassified-create-rejection";

export function classifyExeCreateRejection(stderr: unknown): ExeCreateVmReason {
  const text = providerText(stderr).toLowerCase();
  if (text.includes("integration")) return "integration-required";
  if (text.includes("tag")) return "invalid-tag";
  if (text.includes("image")) return "unknown-image";
  if (text.includes("taken") || text.includes("exists") || text.includes("already"))
    return "name-taken";
  if (text.includes("quota") || text.includes("limit")) return "quota-exceeded";
  if (text.includes("pool") || text.includes("team")) return "team-pool-required";
  return "unclassified-create-rejection";
}

export class ExeCommandError extends Error {
  readonly detail?: string;

  constructor(
    readonly operation: string,
    readonly timedOut: boolean,
    readonly exitCode: number | null,
    readonly reason?: ExeCreateVmReason,
    detail?: string,
  ) {
    super(`${operation} failed${timedOut ? " by timeout" : ""}`);
    // ponytail: non-enumerable detail keeps raw-adjacent text out of JSON/spread leaks;
    // controller must sanitizeTelemetryText it with run credentials before any output.
    Object.defineProperty(this, "detail", {
      value: detail,
      enumerable: false,
      writable: false,
    });
  }
}

function providerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    try {
      return Buffer.from(value).toString("utf8");
    } catch {
      return "";
    }
  }
  return "";
}

function stripAnsiCsi(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const esc = value.indexOf("\u001b", i);
    if (esc === -1) return out + value.slice(i);
    out += value.slice(i, esc);
    if (value[esc + 1] !== "[") {
      i = esc + 1;
      continue;
    }
    let end = esc + 2;
    while (end < value.length) {
      const code = value.charCodeAt(end);
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
        end += 1;
        break;
      }
      end += 1;
    }
    i = end;
  }
  return out;
}

function redactGenericProviderText(value: string): string {
  return stripAnsiCsi(value)
    .replaceAll(/\p{Cc}/gu, " ")
    .replaceAll(/(https?:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
    .replaceAll(/\b(bearer|basic)\s+[^\s"'}]+/gi, "$1 [REDACTED]")
    .replaceAll(
      /\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s"'};,]+/gi,
      "$1=[REDACTED]",
    );
}

function boundedDetail(raw: string): string | undefined {
  if (!raw || raw.length > 20_000) return undefined;
  const cleaned = redactGenericProviderText(raw).replaceAll(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  // ponytail: no display cap here; controller redacts known run credentials first,
  // then applies its sole display cap. Premature slice would clip a secret
  // spanning the boundary so full-token replacement misses its prefix.
  return cleaned;
}

function strictStdoutMessage(stdout: string): string | undefined {
  if (!stdout || stdout.length > 100_000) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
  if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
  if (isRecord(parsed.error) && typeof parsed.error.message === "string") {
    return parsed.error.message.trim() ? parsed.error.message : undefined;
  }
  return undefined;
}

// Create-VM only: prefer stderr, else strict JSON message field from stdout.
// Never returns whole stdout/command dumps; controller redacts run credentials after.
function createVmDetail(error: Record<string, unknown>): string | undefined {
  const stderr = providerText(error.stderr);
  if (stderr.trim()) return boundedDetail(stderr);
  return boundedDetail(strictStdoutMessage(providerText(error.stdout)) ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-blank`);
  return value;
}

function safeName(value: unknown, label: string): string {
  const result = nonBlank(value, label);
  if (!SAFE_VM_NAME.test(result)) throw new Error(`invalid ${label}`);
  return result;
}

function safeDestination(value: unknown): string {
  const result = nonBlank(value, "SSH destination");
  const host = result.includes("@") ? result.slice(result.lastIndexOf("@") + 1) : result;
  if (!SAFE_DESTINATION.test(result) || result.startsWith("-") || host.startsWith("-")) {
    throw new Error("invalid SSH destination");
  }
  return result;
}

function safeLocalPath(value: string): string {
  if (!isAbsolute(value) || value.includes("\0")) throw new Error("invalid local path");
  return value;
}

function safeRemotePath(value: string): string {
  if (
    !value.startsWith("/") ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.split("/").includes("..") ||
    posix.normalize(value) !== value
  ) {
    throw new Error("invalid remote path");
  }
  return value;
}

export function quoteRemoteArg(value: string): string {
  if (value.includes("\0")) throw new Error("remote argument contains NUL");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function parseVm(value: unknown, defaultStatus?: string): ExeVm {
  if (!isRecord(value)) throw new Error("invalid exe.dev VM response");
  const vmName = safeName(value.vm_name, "VM name");
  const status =
    value.status === undefined
      ? nonBlank(defaultStatus, "VM status")
      : nonBlank(value.status, "VM status");
  const sshDest = safeDestination(value.ssh_dest);
  const sshHost = value.ssh_host === undefined ? undefined : nonBlank(value.ssh_host, "SSH host");
  const sshUser = value.ssh_user === undefined ? undefined : nonBlank(value.ssh_user, "SSH user");
  return {
    vmName,
    status,
    sshDest,
    ...(sshHost ? { sshHost } : {}),
    ...(sshUser ? { sshUser } : {}),
  };
}

function commandFailure(error: unknown, operation: string): ExeCommandError {
  if (!isRecord(error)) return new ExeCommandError(operation, false, null);
  const timedOut = error.killed === true || error.code === "ETIMEDOUT";
  const exitCode =
    typeof error.status === "number"
      ? error.status
      : typeof error.code === "number"
        ? error.code
        : null;
  if (operation === "create VM" && !timedOut)
    return new ExeCommandError(
      operation,
      timedOut,
      exitCode,
      classifyExeCreateRejection(error.stderr),
      createVmDetail(error),
    );
  return new ExeCommandError(operation, timedOut, timedOut ? null : exitCode);
}

const defaultRunner: ExeRunner = async (file, args, options) => {
  const result = await execFileAsync(file, args, {
    timeout: options.timeout,
    maxBuffer: 2_000_000,
    encoding: "utf8",
    env: options.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

const defaultStreamRunner: ExeStreamRunner = (file, args, options, onStdout) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env,
    });
    let stderr = "";
    let timedOut = false;
    let callbackError: unknown;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const clear = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeout);
    child.stdout.on("data", (chunk: Buffer) => {
      if (callbackError) return;
      try {
        onStdout(chunk);
      } catch (error) {
        callbackError = error;
        terminate();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-1_000_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clear();
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clear();
      if (callbackError) reject(callbackError);
      else if (code === 0 && !timedOut) resolve({ stderr });
      else reject({ killed: timedOut, code: timedOut ? "ETIMEDOUT" : code, stderr });
    });
  });

export class ExeClient {
  private readonly connectionOptions: string[];
  private readonly commandEnv: NodeJS.ProcessEnv;

  constructor(
    private readonly runner: ExeRunner = defaultRunner,
    private readonly timeoutMs = 30_000,
    identityFile?: string,
    private readonly streamRunner: ExeStreamRunner = defaultStreamRunner,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("exe.dev timeout must be a positive integer");
    }
    this.connectionOptions = identityFile
      ? [...SSH_OPTIONS, "-o", "IdentitiesOnly=yes", "-i", safeLocalPath(identityFile)]
      : SSH_OPTIONS;
    this.commandEnv = sshCommandEnvironment(environment);
  }

  private async invoke(
    operation: string,
    file: string,
    args: string[],
    timeout = this.timeoutMs,
  ): Promise<ExecResult> {
    try {
      return await this.runner(file, args, { timeout, env: this.commandEnv });
    } catch (error) {
      throw commandFailure(error, operation);
    }
  }

  private async controlJson(
    operation: string,
    args: string[],
    connectionOptions = this.connectionOptions,
  ): Promise<unknown> {
    const result = await this.invoke(operation, "ssh", [
      ...connectionOptions,
      "-n",
      "exe.dev",
      ...args,
    ]);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(`invalid exe.dev JSON for ${operation}`);
    }
  }

  async createVm(options: { name: string; tag: string; integration?: string }): Promise<ExeVm> {
    const name = safeName(options.name, "VM name");
    const tag = assertExeTag(options.tag);
    const args = [
      "new",
      "--json",
      `--name=${name}`,
      "--image=exeuntu",
      `--tag=${tag}`,
      "--no-email",
    ];
    if (options.integration)
      args.push(`--integration=${safeName(options.integration, "integration")}`);
    const value = await this.controlJson("create VM", args);
    const vm = parseVm(isRecord(value) && "vm" in value ? value.vm : value, "creating");
    if (vm.vmName !== name) throw new Error("exe.dev created unexpected VM");
    return vm;
  }

  async listVms(): Promise<ExeVm[]> {
    const value = await this.controlJson("list VMs", ["ls", "--json"]);
    if (!isRecord(value) || !Array.isArray(value.vms)) throw new Error("invalid exe.dev VM list");
    return value.vms.map((vm) => parseVm(vm));
  }

  async exec(sshDest: string, argv: string[], timeoutMs = this.timeoutMs): Promise<ExecResult> {
    const destination = safeDestination(sshDest);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("remote command timeout must be a positive integer");
    }
    if (!argv.length || !argv[0]?.trim()) throw new Error("empty remote command");
    const command = argv.map(quoteRemoteArg).join(" ");
    return this.invoke(
      "remote command",
      "ssh",
      [...this.connectionOptions, destination, command],
      timeoutMs,
    );
  }

  async execStream(
    sshDest: string,
    argv: string[],
    onStdout: (chunk: Buffer) => void,
    timeoutMs = this.timeoutMs,
  ): Promise<{ stderr: string }> {
    const destination = safeDestination(sshDest);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("remote command timeout must be a positive integer");
    }
    if (!argv.length || !argv[0]?.trim()) throw new Error("empty remote command");
    const command = argv.map(quoteRemoteArg).join(" ");
    try {
      return await this.streamRunner(
        "ssh",
        [...this.connectionOptions, destination, command],
        { timeout: timeoutMs, env: this.commandEnv },
        onStdout,
      );
    } catch (error) {
      throw commandFailure(error, "remote command");
    }
  }

  async copyTo(sshDest: string, localPath: string, remotePath: string): Promise<ExecResult> {
    const destination = safeDestination(sshDest);
    return this.invoke("copy to VM", "scp", [
      ...this.connectionOptions,
      safeLocalPath(localPath),
      `${destination}:${safeRemotePath(remotePath)}`,
    ]);
  }

  async copyFrom(sshDest: string, remotePath: string, localPath: string): Promise<ExecResult> {
    const destination = safeDestination(sshDest);
    return this.invoke("copy from VM", "scp", [
      ...this.connectionOptions,
      `${destination}:${safeRemotePath(remotePath)}`,
      safeLocalPath(localPath),
    ]);
  }

  async addSshKey(publicKey: string, tag: string): Promise<void> {
    if (!SAFE_PUBLIC_KEY.test(publicKey)) throw new Error("invalid exe.dev public key");
    await this.controlJson("add SSH key", [
      "ssh-key",
      "add",
      `--tag=${safeName(tag, "SSH key tag")}`,
      quoteRemoteArg(publicKey),
      "--json",
    ]);
  }

  async removeSshKey(publicKey: string): Promise<void> {
    if (!SAFE_PUBLIC_KEY.test(publicKey)) throw new Error("invalid exe.dev public key");
    await this.controlJson("remove SSH key", [
      "ssh-key",
      "remove",
      quoteRemoteArg(publicKey),
      "--json",
    ]);
  }

  async hasSshKey(publicKey: string): Promise<boolean> {
    if (!SAFE_PUBLIC_KEY.test(publicKey)) throw new Error("invalid exe.dev public key");
    const value = await this.controlJson("list SSH keys", ["ssh-key", "list", "--json"]);
    if (!isRecord(value) || !Array.isArray(value.ssh_keys))
      throw new Error("invalid exe.dev SSH key list");
    const key = publicKey.split(" ").slice(0, 2).join(" ");
    return value.ssh_keys.some(
      (entry) =>
        isRecord(entry) && typeof entry.public_key === "string" && entry.public_key === key,
    );
  }

  async destroyVmFromWithin(vmName: string, publicKey: string): Promise<void> {
    const name = safeName(vmName, "VM name");
    if (!SAFE_PUBLIC_KEY.test(publicKey)) throw new Error("invalid exe.dev public key");
    const socket = `/tmp/maquila-exe-${process.pid}-${randomBytes(8).toString("hex")}`;
    await this.invoke("open exe.dev cleanup connection", "ssh", [
      ...this.connectionOptions,
      "-M",
      "-S",
      socket,
      "-fN",
      "exe.dev",
    ]);
    const master = [...this.connectionOptions, "-S", socket];
    let removed = false;
    try {
      await this.controlJson(
        "remove controller SSH key",
        ["ssh-key", "remove", quoteRemoteArg(publicKey), "--json"],
        master,
      );
      removed = true;
      await this.controlJson("destroy controller VM", ["rm", name, "--json"], master);
    } catch (error) {
      if (removed)
        await this.controlJson(
          "restore controller SSH key",
          ["ssh-key", "add", "--tag=maquila-controller", quoteRemoteArg(publicKey), "--json"],
          master,
        ).catch(() => undefined);
      throw error;
    } finally {
      await this.invoke("close exe.dev cleanup connection", "ssh", [
        ...master,
        "-O",
        "exit",
        "exe.dev",
      ]).catch(() => undefined);
      rmSync(socket, { force: true });
    }
  }

  async configurePublicProxy(vmName: string, port: number): Promise<void> {
    const name = safeName(vmName, "VM name");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid proxy port");
    await this.controlJson("set proxy port", ["share", "port", name, String(port), "--json"]);
    await this.controlJson("set proxy public", ["share", "set-public", name, "--json"]);
  }

  async makeProxyPrivate(vmName: string): Promise<void> {
    await this.controlJson("set proxy private", [
      "share",
      "set-private",
      safeName(vmName, "VM name"),
      "--json",
    ]);
  }

  async destroyVm(vmName: string): Promise<{ destroyed: boolean; notFound: boolean }> {
    const name = safeName(vmName, "VM name");
    const exists = (await this.listVms()).some((vm) => vm.vmName === name);
    if (!exists) return { destroyed: false, notFound: true };
    await this.controlJson("destroy VM", ["rm", name, "--json"]);
    return { destroyed: true, notFound: false };
  }
}
