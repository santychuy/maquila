import { execFile } from "node:child_process";
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
];

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeout: number;
}

export type ExeRunner = (file: string, args: string[], options: RunOptions) => Promise<ExecResult>;

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
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export class ExeClient {
  private readonly connectionOptions: string[];

  constructor(
    private readonly runner: ExeRunner = defaultRunner,
    private readonly timeoutMs = 30_000,
    identityFile?: string,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("exe.dev timeout must be a positive integer");
    }
    this.connectionOptions = identityFile
      ? [...SSH_OPTIONS, "-o", "IdentitiesOnly=yes", "-i", safeLocalPath(identityFile)]
      : SSH_OPTIONS;
  }

  private async invoke(
    operation: string,
    file: string,
    args: string[],
    timeout = this.timeoutMs,
  ): Promise<ExecResult> {
    try {
      return await this.runner(file, args, { timeout });
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
