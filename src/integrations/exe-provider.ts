import {
  type ExecutionProvider,
  type ExecutionResult,
  type ExecutionVm,
  validateExecutionReference,
} from "../providers.js";
import { ExeClient } from "./exe.js";
export const EXE_PROVIDER = "exe.dev";
type ExeOperations = Pick<
  ExeClient,
  "createVm" | "destroyVm" | "exec" | "execStream" | "copyTo" | "copyFrom"
>;
export interface ExeExecutionProviderOptions {
  /** Optional production client replacement, primarily for controlled embedding. */
  client?: ExeOperations;
  identity?: string;
  timeoutMs?: number;
}
/** Creates an exe.dev execution provider with a production ExeClient by default. */
export function createExeExecutionProvider(
  options: ExeExecutionProviderOptions = {},
): ExecutionProvider {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new Error("exe.dev provider options must be an object");
  if (Object.keys(options).some((key) => !["client", "identity", "timeoutMs"].includes(key)))
    throw new Error("exe.dev provider options have unknown fields");
  if (
    options.identity !== undefined &&
    (!options.identity.startsWith("/") || options.identity.includes("\0"))
  )
    throw new Error("identity must be absolute");
  const client =
    options.client ?? new ExeClient(undefined, options.timeoutMs ?? 30_000, options.identity);
  return new ExeExecutionProvider({ client });
}
export class ExeExecutionProvider implements ExecutionProvider {
  private readonly client: ExeOperations;
  constructor(options: { client: ExeOperations }) {
    this.client = options.client;
  }
  async createVm(
    reference: unknown,
    options: { name: string; tag: string; integration?: string },
  ): Promise<ExecutionVm> {
    validateExecutionReference(reference, EXE_PROVIDER);
    const vm = await this.client.createVm(options);
    return { name: vm.vmName, status: vm.status, destination: vm.sshDest };
  }
  destroyVm(reference: unknown, name: string): Promise<{ destroyed: boolean; notFound: boolean }> {
    validateExecutionReference(reference, EXE_PROVIDER);
    return this.client.destroyVm(name);
  }
  exec(
    reference: unknown,
    destination: string,
    argv: string[],
    timeoutMs?: number,
  ): Promise<ExecutionResult> {
    validateExecutionReference(reference, EXE_PROVIDER);
    return this.client.exec(destination, argv, timeoutMs);
  }
  execStream(
    reference: unknown,
    destination: string,
    argv: string[],
    onStdout: (chunk: Buffer) => void,
    timeoutMs?: number,
  ): Promise<{ stderr: string }> {
    validateExecutionReference(reference, EXE_PROVIDER);
    return this.client.execStream(destination, argv, onStdout, timeoutMs);
  }
  copyTo(
    reference: unknown,
    destination: string,
    localPath: string,
    remotePath: string,
  ): Promise<ExecutionResult> {
    validateExecutionReference(reference, EXE_PROVIDER);
    return this.client.copyTo(destination, localPath, remotePath);
  }
  copyFrom(
    reference: unknown,
    destination: string,
    remotePath: string,
    localPath: string,
  ): Promise<ExecutionResult> {
    validateExecutionReference(reference, EXE_PROVIDER);
    return this.client.copyFrom(destination, remotePath, localPath);
  }
}
