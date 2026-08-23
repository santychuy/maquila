import { execFile, spawn } from "node:child_process";
import { isAbsolute, posix } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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

export class ExeCommandError extends Error {
  constructor(
    readonly operation: string,
    readonly timedOut: boolean,
    readonly exitCode: number | null,
  ) {
    super(`${operation} failed${timedOut ? " by timeout" : ""}`);
  }
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
  if (!SAFE_NAME.test(result)) throw new Error(`invalid ${label}`);
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

  private async controlJson(operation: string, args: string[]): Promise<unknown> {
    const result = await this.invoke(operation, "ssh", [
      ...this.connectionOptions,
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
    const tag = safeName(options.tag, "tag");
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

  async destroyVm(vmName: string): Promise<{ destroyed: boolean; notFound: boolean }> {
    const name = safeName(vmName, "VM name");
    const exists = (await this.listVms()).some((vm) => vm.vmName === name);
    if (!exists) return { destroyed: false, notFound: true };
    await this.controlJson("destroy VM", ["rm", name, "--json"]);
    return { destroyed: true, notFound: false };
  }
}
