import type { PlanOptions } from "../workflows/plan.js";
import type { WorkerLifecycleOptions } from "../workflows/worker.js";
import type { ControllerOptions } from "../controller.js";

export const HELP = `Usage:
  maquila agents list
  maquila setup [--target PATH] [--identity ABS] [--linear-token-reference op://Vault/Item/field] [--openrouter-token-reference op://Vault/Item/field] [--install-skill] [--json] [--agent] [--from-scratch]
  maquila doctor [--target PATH] [--identity ABS] [--issue ID] [--require-label LABEL] [--json] [--agent]
  maquila pi plan --repo PATH --issue PATH [--timeout-seconds 300]
  maquila pi worker --repo PATH --issue PATH --planner PATH --base-sha SHA [--timeout-seconds 300]
  maquila run --issue ID --owner OWNER --repo REPO --base-ref REF --tag TAG [--identity ABS] [--timeout-seconds 900]
  maquila run start --issue ID [--target PATH] [--owner OWNER] [--repo REPO] [--base-ref REF] [--tag TAG] [--identity ABS] [--timeout-seconds 900] [--json]
  maquila run batch --issue ID --issue ID [--target PATH] [--owner OWNER] [--repo REPO] [--base-ref REF] [--tag TAG] [--identity ABS] [--timeout-seconds 900] [--json]
  maquila run batch status --batch-id UUID [--json]
  maquila run resume --run-id UUID [--identity ABS] [--json]
  maquila run status --run-id UUID [--json]
  maquila intake deploy --target PATH --allow-credential-transfer [--ttl 24h] [--controller-name NAME] [--port 8080] [--identity ABS] [--json]
  maquila intake status [--identity ABS] [--json]
  maquila intake destroy [--identity ABS] [--json]
  maquila intake serve --target PATH --port PORT [--poll-interval-ms 60000]
  maquila dashboard [--port 4600]
  maquila observer serve [--port 4600]
  maquila observer ensure [--port 4600] --json
  maquila observer status --json
  maquila observer stop --json

Lists agents or runs planner, worker/reviewer, and remote controller workflows.
`;

export interface IntakeDeployCommand {
  command: "intake-deploy";
  target: string;
  controllerName: string;
  port: number;
  allowCredentialTransfer: true;
  ttlSeconds?: number;
  identity?: string;
  json?: boolean;
  timeoutSeconds?: undefined;
}

export interface IntakeLifecycleCommand {
  command: "intake-status" | "intake-destroy" | "intake-expire";
  identity?: string;
  json?: boolean;
  timeoutSeconds?: undefined;
}

export interface IntakeServeCommand {
  command: "intake-serve";
  target: string;
  port: number;
  pollMilliseconds: number;
  timeoutSeconds?: undefined;
}

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
  automaticAdmission?: boolean;
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
  agent?: boolean;
  fromScratch?: boolean;
  linearTokenReference?: string;
  openRouterTokenReference?: string;
  installSkill?: boolean;
  target: string;
  identity?: string;
}

export interface DoctorCommand {
  command: "doctor";
  timeoutSeconds?: undefined;
  json?: boolean;
  agent?: boolean;
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
  | IntakeDeployCommand
  | IntakeLifecycleCommand
  | IntakeServeCommand
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
