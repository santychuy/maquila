import type { PlanOptions } from "../workflows/plan.js";
import type { WorkerLifecycleOptions } from "../workflows/worker.js";
import type { ControllerOptions } from "../controller.js";

export const HELP = `Usage:
  factory agents list
  factory setup [--linear-token-reference op://Vault/Item/field] [--openrouter-token-reference op://Vault/Item/field] [--install-skill] [--json]
  factory doctor [--target PATH] [--json]
  factory pi plan --repo PATH --issue PATH [--timeout-seconds 300]
  factory pi worker --repo PATH --issue PATH --planner PATH --base-sha SHA [--timeout-seconds 300]
  factory run --issue ID --owner OWNER --repo REPO --base-ref REF --tag TAG [--identity ABS] [--timeout-seconds 900]
  factory run start --issue ID [--target PATH] [--owner OWNER] [--repo REPO] [--base-ref REF] [--tag TAG] [--identity ABS] [--timeout-seconds 900] [--json]
  factory run status --run-id UUID [--json]
  factory dashboard [--port 4600]
  factory observer serve [--port 4600]
  factory observer ensure [--port 4600] --json
  factory observer status --json
  factory observer stop --json

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
}

export interface DoctorCommand {
  command: "doctor";
  timeoutSeconds?: undefined;
  json?: boolean;
  target: string;
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
  | RunExecuteCommand
  | RunStatusCommand
  | ObserverServeCommand
  | ObserverReadCommand
  | SetupCommand
  | DoctorCommand
  | "help"
  | "list-agents";
