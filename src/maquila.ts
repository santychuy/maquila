import { randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { runControllerChain } from "./controller-chain.js";
import type { ControllerResult } from "./controller.js";
import type {
  EventSink,
  ExecutionProvider,
  SourceControlProvider,
  WorkItemProvider,
} from "./providers.js";
import { maquilaRoot } from "./runtime.js";

export interface MaquilaWorkItemReference {
  provider: string;
  id: string;
}
/** Phase 1 is intentionally Git and pull-request oriented. */
export interface MaquilaSourceControlReference {
  provider: string;
  repository: string;
  baseRef: string;
}
export interface MaquilaExecutionReference {
  provider: string;
  /** Required safe routing tag for the current execution controller. */
  tag: string;
}
export interface MaquilaConfig {
  workItemProvider: WorkItemProvider;
  sourceControlProvider: SourceControlProvider;
  executionProvider: ExecutionProvider;
  eventSink?: EventSink;
  /** Exact absolute directory where this instance retains controller state. */
  stateDirectory: string;
  /** Credential for the installed Maquila agent runtime. It is never retained publicly. */
  openRouterApiKey: string;
}
export interface MaquilaRunRequest {
  workItem: MaquilaWorkItemReference;
  sourceControl: MaquilaSourceControlReference;
  execution: MaquilaExecutionReference;
  timeoutSeconds?: number;
  mode?: "publish" | "dry-run";
}
export interface MaquilaPublication {
  mode: "published";
  number: number;
  url: string;
  branch: string;
  commitSha: string;
}
export interface MaquilaDryRun {
  mode: "dry-run";
  repository: string;
  baseRef: string;
  baseSha: string;
  proposedBranch: string;
  patchSha256: string;
}
export interface MaquilaRunResult {
  runId: string;
  runDirectory: string;
  status: "completed" | "failed" | "cancelled";
  publication?: MaquilaPublication | MaquilaDryRun;
  error?: string;
}
export interface Maquila {
  run(request: MaquilaRunRequest): Promise<MaquilaRunResult>;
}

/** Internal controller controls. This is not part of the package entrypoint. */
export interface InternalMaquilaRunControls {
  runId?: string;
  onAccepted?: () => void;
  maquilaRoot?: string;
}

type ObjectRecord = Record<string, unknown>;
function object(value: unknown, label: string): ObjectRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value));
}
function exact(value: unknown, keys: readonly string[], label: string): ObjectRecord {
  const fields = object(value, label);
  if (Object.keys(fields).some((key) => !keys.includes(key)))
    throw new Error(`${label} has unknown fields`);
  return fields;
}
function safeString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new Error(`${label} must be a safe non-blank string`);
  return value;
}
function provider(value: unknown, label: string): string {
  return safeString(value, label);
}
function hasMethods(value: unknown, methods: readonly string[], label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  if (methods.some((method) => typeof Reflect.get(value, method) !== "function"))
    throw new Error(`${label} is invalid`);
}
function absoluteDirectory(value: unknown): string {
  const directory = safeString(value, "stateDirectory");
  if (!isAbsolute(directory) || normalize(directory) !== directory)
    throw new Error("stateDirectory must be an exact absolute path");
  return directory;
}
function config(value: MaquilaConfig): MaquilaConfig {
  const fields = exact(
    value,
    [
      "workItemProvider",
      "sourceControlProvider",
      "executionProvider",
      "eventSink",
      "stateDirectory",
      "openRouterApiKey",
    ],
    "Maquila config",
  );
  hasMethods(
    fields.workItemProvider,
    ["fetchWorkItem", "requestDecision", "waitForDecision"],
    "workItemProvider",
  );
  hasMethods(
    fields.sourceControlProvider,
    ["fetchSourceControl", "cloneUrl", "dryRunPublication", "publishReviewedPatch"],
    "sourceControlProvider",
  );
  hasMethods(
    fields.executionProvider,
    ["createVm", "destroyVm", "exec", "execStream", "copyTo", "copyFrom"],
    "executionProvider",
  );
  if (fields.eventSink !== undefined) hasMethods(fields.eventSink, ["emit"], "eventSink");
  return {
    workItemProvider: value.workItemProvider,
    sourceControlProvider: value.sourceControlProvider,
    executionProvider: value.executionProvider,
    ...(value.eventSink === undefined ? {} : { eventSink: value.eventSink }),
    stateDirectory: absoluteDirectory(fields.stateDirectory),
    openRouterApiKey: safeString(fields.openRouterApiKey, "openRouterApiKey"),
  };
}
function request(
  value: MaquilaRunRequest,
): Required<Pick<MaquilaRunRequest, "workItem" | "sourceControl" | "execution">> &
  Pick<MaquilaRunRequest, "timeoutSeconds" | "mode"> {
  const fields = exact(
    value,
    ["workItem", "sourceControl", "execution", "timeoutSeconds", "mode"],
    "Maquila run request",
  );
  const workItem = exact(fields.workItem, ["provider", "id"], "workItem reference");
  const sourceControl = exact(
    fields.sourceControl,
    ["provider", "repository", "baseRef"],
    "sourceControl reference",
  );
  const execution = exact(fields.execution, ["provider", "tag"], "execution reference");
  const repository = safeString(sourceControl.repository, "repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("repository must be owner/repo");
  const baseRef = safeString(sourceControl.baseRef, "baseRef");
  if (!/^[A-Za-z0-9._/-]+$/.test(baseRef) || baseRef.includes(".."))
    throw new Error("baseRef is unsafe");
  const timeoutSeconds = fields.timeoutSeconds === undefined ? 900 : fields.timeoutSeconds;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 1800
  )
    throw new Error("timeoutSeconds must be an integer from 1 to 1800");
  if (fields.mode !== undefined && fields.mode !== "publish" && fields.mode !== "dry-run")
    throw new Error("mode must be publish or dry-run");
  return {
    workItem: {
      provider: provider(workItem.provider, "workItem provider"),
      id: safeString(workItem.id, "workItem ID"),
    },
    sourceControl: {
      provider: provider(sourceControl.provider, "sourceControl provider"),
      repository,
      baseRef,
    },
    execution: {
      provider: provider(execution.provider, "execution provider"),
      tag: safeString(execution.tag, "execution tag"),
    },
    timeoutSeconds,
    ...(fields.mode === undefined ? {} : { mode: fields.mode }),
  };
}
function terminalResult(runId: string, value: ControllerResult): MaquilaRunResult {
  if (value.status === "awaiting_decision")
    throw new Error("controller returned an unexpected decision wait");
  const publication = value.pullRequest
    ? { mode: "published" as const, ...value.pullRequest }
    : value.publicationDryRun
      ? {
          mode: "dry-run" as const,
          repository: value.publicationDryRun.repository,
          baseRef: value.publicationDryRun.baseRef,
          baseSha: value.publicationDryRun.baseSha,
          proposedBranch: value.publicationDryRun.proposedBranch,
          patchSha256: value.publicationDryRun.patchSha256,
        }
      : undefined;
  return {
    runId,
    runDirectory: value.runDir,
    status: value.status,
    ...(publication ? { publication } : {}),
    ...(value.error ? { error: value.error } : {}),
  };
}
/** Runs the validated facade path with controller-only compatibility controls. */
export async function runMaquila(
  input: MaquilaConfig,
  inputRequest: MaquilaRunRequest,
  controls: InternalMaquilaRunControls = {},
): Promise<MaquilaRunResult> {
  const bound = config(input);
  const parsed = request(inputRequest);
  const repositoryParts = parsed.sourceControl.repository.split("/");
  const owner = repositoryParts[0];
  const repo = repositoryParts[1];
  if (!owner || !repo || repositoryParts.length !== 2)
    throw new Error("repository must be owner/repo");
  const runId = controls.runId ?? randomUUID();
  const controllerResult = await runControllerChain({
    issue: parsed.workItem.id,
    owner,
    repo,
    baseRef: parsed.sourceControl.baseRef,
    tag: parsed.execution.tag,
    timeoutSeconds: parsed.timeoutSeconds!,
    linearToken: "",
    githubToken: "",
    openRouterKey: bound.openRouterApiKey,
    maquilaRoot: controls.maquilaRoot ?? maquilaRoot(import.meta.dirname),
    runId,
    publicationMode: parsed.mode ?? "publish",
    ...(controls.onAccepted ? { onAccepted: controls.onAccepted } : {}),
    infrastructure: {
      workItems: bound.workItemProvider,
      workItemReference: parsed.workItem,
      sourceControl: bound.sourceControlProvider,
      sourceControlReference: parsed.sourceControl,
      execution: bound.executionProvider,
      executionReference: parsed.execution,
      stateDirectory: bound.stateDirectory,
      ...(bound.eventSink ? { eventSink: bound.eventSink } : {}),
    },
  });
  return terminalResult(runId, controllerResult);
}

/** Creates an isolated, blocking Phase 1 Maquila SDK instance. */
export function createMaquila(input: MaquilaConfig): Maquila {
  const bound = config(input);
  return {
    run(inputRequest: MaquilaRunRequest): Promise<MaquilaRunResult> {
      return runMaquila(bound, inputRequest);
    },
  };
}
