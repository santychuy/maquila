import type { PlanOptions } from "../workflows/plan.js";
import type { WorkerLifecycleOptions } from "../workflows/worker.js";
import type { ControllerOptions } from "../controller.js";

export const HELP = `Usage:
  maquila agents list
  maquila setup [--target PATH] [--identity ABS] [--linear-token-reference op://Vault/Item/field] [--openrouter-token-reference op://Vault/Item/field] [--install-skill] [--json]
  maquila doctor [--target PATH] [--identity ABS] [--issue ID] [--require-label LABEL] [--json]
  maquila pi plan --repo PATH --issue PATH [--timeout-seconds 300]
  maquila pi worker --repo PATH --issue PATH --planner PATH --base-sha SHA [--timeout-seconds 300]
  maquila run --issue ID --owner OWNER --repo REPO --base-ref REF --tag TAG [--identity ABS] [--timeout-seconds 900]
  maquila run start --issue ID [--target PATH] [--owner OWNER] [--repo REPO] [--base-ref REF] [--tag TAG] [--identity ABS] [--timeout-seconds 900] [--json]
  maquila run batch --issue ID --issue ID [--target PATH] [--owner OWNER] [--repo REPO] [--base-ref REF] [--tag TAG] [--identity ABS] [--timeout-seconds 900] [--json]
  maquila run batch status --batch-id UUID [--json]
  maquila run resume --run-id UUID [--identity ABS] [--json]
  maquila run status --run-id UUID [--json]
  maquila dashboard [--port 4600]
  maquila observer serve [--port 4600]
  maquila observer ensure [--port 4600] --json
  maquila observer status --json
  maquila observer stop --json

Lists agents or runs planner, worker/reviewer, and remote controller workflows.
`;

export interface RunStartCommand {
  command: "run-start";
  target: string;
  issue: string;
  owner?: string;
  repo?: string;
  baseRef?: string;
  tag?: string;
  identity?: string;
  timeoutSeconds: number;
  json?: boolean;
}

export interface RunBatchCommand {
  command: "run-batch";
  target: string;
  issues: string[];
  owner?: string;
  repo?: string;
  baseRef?: string;
  tag?: string;
  identity?: string;
  timeoutSeconds: number;
  json?: boolean;
}

export interface RunBatchExecuteCommand {
  command: "run-batch-execute";
  batchId: string;
  timeoutSeconds?: undefined;
}

export interface RunBatchStatusCommand {
  command: "run-batch-status";
  batchId: string;
  json?: boolean;
  timeoutSeconds?: undefined;
}

export interface RunExecuteCommand {
  command: "run-execute";
  runId: string;
  issue: string;
  owner: string;
  repo: string;
  baseRef: string;
  tag: string;
  timeoutSeconds: number;
}

export interface RunResumeCommand {
  command: "run-resume";
  runId: string;
  identity?: string;
  json?: boolean;
  timeoutSeconds?: undefined;
}

export interface RunStatusCommand {
  command: "run-status";
  runId: string;
  json?: boolean;
  timeoutSeconds?: undefined;
}

export interface ObserverServeCommand {
  command: "dashboard" | "observer-serve" | "observer-ensure";
  port: number;
  timeoutSeconds?: undefined;
}

export interface ObserverReadCommand {
  command: "observer-status" | "observer-stop";
  timeoutSeconds?: undefined;
}

export interface SetupCommand {
  command: "setup";
  timeoutSeconds?: undefined;
  json?: boolean;
  linearTokenReference?: string;
  openRouterTokenReference?: string;
  installSkill?: boolean;
  target?: string;
  identity?: string;
}

export interface DoctorCommand {
  command: "doctor";
  timeoutSeconds?: undefined;
  json?: boolean;
  target: string;
  identity?: string;
  issue?: string;
  requireLabel?: string;
}

export type WorkerCliOptions = WorkerLifecycleOptions & { machine?: boolean };
export type PlanCliOptions = PlanOptions;
export type DirectRunOptions = Omit<
  ControllerOptions,
  "linearToken" | "githubToken" | "openRouterKey"
>;

export type ParsedCli =
  | PlanCliOptions
  | WorkerCliOptions
  | DirectRunOptions
  | RunStartCommand
  | RunBatchCommand
  | RunBatchExecuteCommand
  | RunBatchStatusCommand
  | RunExecuteCommand
  | RunResumeCommand
  | RunStatusCommand
  | ObserverServeCommand
  | ObserverReadCommand
  | SetupCommand
  | DoctorCommand
  | "help"
  | "list-agents";
