#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { listAgents } from "./agents/index.js";
import { runPlan, type PlanOptions } from "./plan.js";
import { runWorkerLifecycle, type WorkerLifecycleOptions } from "./worker.js";
import { runController, type ControllerOptions } from "./controller.js";
import { createRemoteProtocolWriter } from "./remote-protocol.js";
import { loadFactoryConfig } from "./config.js";
import { resolveControllerCredentials } from "./credentials.js";
import { runDoctor } from "./doctor.js";
import { runSetup } from "./setup.js";
import { startDetachedRun, writeLaunchHandshake } from "./run-launcher.js";
import { foldRunStatus, type RunStatusSummary } from "./run-status.js";
import { factoryRoot, isMain } from "./runtime.js";
import { validateResolvedTarget } from "./target.js";
import {
  DEFAULT_OBSERVER_PORT,
  ensureObserver,
  observerStatus,
  serveObserver,
  stopObserver,
} from "./observer.js";

export const HELP = `Usage:
  factory agents list
  factory setup [--linear-token-reference op://Vault/Item/field] [--install-skill] [--json]
  factory doctor [--target PATH] [--json]
  factory pi plan --repo PATH --issue PATH --model PROVIDER/MODEL [--timeout-seconds 300]

Lists agents or runs planner, worker/reviewer, and remote controller workflows.
  factory pi worker --repo PATH --issue PATH --planner PATH --base-sha SHA --model PROVIDER/MODEL [--timeout-seconds 300]
  factory run --issue ID --owner OWNER --repo REPO --base-ref REF --tag TAG [--identity ABS] [--timeout-seconds 900]
  factory run start --issue ID [--target PATH] [--owner OWNER] [--repo REPO] [--base-ref REF] [--tag TAG] [--identity ABS] [--timeout-seconds 900] [--json]
  factory run status --run-id UUID [--json]
  factory dashboard [--port 4600]
  factory observer serve [--port 4600]
  factory observer ensure [--port 4600] --json
  factory observer status --json
  factory observer stop --json

`;

interface RunStartCommand {
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
interface RunExecuteCommand {
  command: "run-execute";
  runId: string;
  issue: string;
  owner: string;
  repo: string;
  baseRef: string;
  tag: string;
  timeoutSeconds: number;
}
interface RunStatusCommand {
  command: "run-status";
  runId: string;
  json?: boolean;
  timeoutSeconds?: undefined;
}
interface ObserverServeCommand {
  command: "dashboard" | "observer-serve" | "observer-ensure";
  port: number;
  timeoutSeconds?: undefined;
}
interface ObserverReadCommand {
  command: "observer-status" | "observer-stop";
  timeoutSeconds?: undefined;
}
interface SetupCommand {
  command: "setup";
  timeoutSeconds?: undefined;
  json?: boolean;
  linearTokenReference?: string;
  installSkill?: boolean;
}
interface DoctorCommand {
  command: "doctor";
  timeoutSeconds?: undefined;
  json?: boolean;
  target: string;
}
type WorkerCliOptions = WorkerLifecycleOptions & { machine?: boolean };

type ParsedCli =
  | PlanOptions
  | WorkerCliOptions
  | Omit<ControllerOptions, "linearToken" | "githubToken">
  | RunStartCommand
  | RunExecuteCommand
  | RunStatusCommand
  | ObserverServeCommand
  | ObserverReadCommand
  | SetupCommand
  | DoctorCommand
  | "help"
  | "list-agents";

function rejectOptions(values: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([key]) => key)
    .filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`unsupported option for command: --${extra[0]}`);
}

function observerPort(value: string | undefined): number {
  const port = Number(value ?? process.env.FACTORY_OBSERVER_PORT ?? DEFAULT_OBSERVER_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("--port must be an integer from 1 to 65535");
  return port;
}

function timeout(value: string | undefined, fallback: string): number {
  const seconds = Number(value ?? fallback);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1800)
    throw new Error("--timeout-seconds must be an integer from 1 to 1800");
  return seconds;
}

export function parseCli(args: string[]): ParsedCli {
  const { positionals, values } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      issue: { type: "string" },
      model: { type: "string" },
      planner: { type: "string" },
      "base-sha": { type: "string" },
      "timeout-seconds": { type: "string" },
      owner: { type: "string" },
      "base-ref": { type: "string" },
      tag: { type: "string" },
      identity: { type: "string" },
      machine: { type: "boolean" },
      target: { type: "string" },
      "run-id": { type: "string" },
      json: { type: "boolean" },
      port: { type: "string" },
      "linear-token-reference": { type: "string" },
      "install-skill": { type: "boolean" },
    },
  });

  if (values.help) {
    rejectOptions(values, ["help"]);
    return "help";
  }
  const command = positionals.join(" ");
  if (command === "setup") {
    rejectOptions(values, ["json", "linear-token-reference", "install-skill"]);
    return {
      command: "setup",
      ...(values.json ? { json: true } : {}),
      ...(values["linear-token-reference"]
        ? { linearTokenReference: values["linear-token-reference"] }
        : {}),
      ...(values["install-skill"] ? { installSkill: true } : {}),
    };
  }
  if (command === "doctor") {
    rejectOptions(values, ["json", "target"]);
    return {
      command: "doctor",
      target: values.target ?? process.cwd(),
      ...(values.json ? { json: true } : {}),
    };
  }
  if (command === "agents list") {
    rejectOptions(values, []);
    return "list-agents";
  }
  if (command === "dashboard") {
    rejectOptions(values, ["port"]);
    return { command: "dashboard", port: observerPort(values.port) };
  }
  if (command === "observer serve") {
    rejectOptions(values, ["port"]);
    return { command: "observer-serve", port: observerPort(values.port) };
  }
  if (command === "observer ensure") {
    rejectOptions(values, ["json", "port"]);
    if (!values.json) throw new Error("observer ensure requires --json");
    return { command: "observer-ensure", port: observerPort(values.port) };
  }
  if (command === "observer status") {
    rejectOptions(values, ["json"]);
    if (!values.json) throw new Error("observer status requires --json");
    return { command: "observer-status" };
  }
  if (command === "observer stop") {
    rejectOptions(values, ["json"]);
    if (!values.json) throw new Error("observer stop requires --json");
    return { command: "observer-stop" };
  }
  if (command === "run start") {
    rejectOptions(values, [
      "json",
      "target",
      "issue",
      "owner",
      "repo",
      "base-ref",
      "tag",
      "identity",
      "timeout-seconds",
    ]);
    if (!values.issue) throw new Error("--issue is required");
    return {
      command: "run-start",
      target: values.target ?? process.cwd(),
      issue: values.issue,
      timeoutSeconds: timeout(values["timeout-seconds"], "900"),
      ...(values.owner ? { owner: values.owner } : {}),
      ...(values.repo ? { repo: values.repo } : {}),
      ...(values["base-ref"] ? { baseRef: values["base-ref"] } : {}),
      ...(values.tag ? { tag: values.tag } : {}),
      ...(values.identity ? { identity: values.identity } : {}),
      ...(values.json ? { json: true } : {}),
    };
  }
  if (command === "run execute") {
    rejectOptions(values, [
      "run-id",
      "issue",
      "owner",
      "repo",
      "base-ref",
      "tag",
      "timeout-seconds",
    ]);
    if (
      !values["run-id"] ||
      !values.issue ||
      !values.owner ||
      !values.repo ||
      !values["base-ref"] ||
      !values.tag
    )
      throw new Error("internal run execute arguments missing");
    return {
      command: "run-execute",
      runId: values["run-id"],
      issue: values.issue,
      owner: values.owner,
      repo: values.repo,
      baseRef: values["base-ref"],
      tag: values.tag,
      timeoutSeconds: timeout(values["timeout-seconds"], "900"),
    };
  }
  if (command === "run status") {
    rejectOptions(values, ["json", "run-id"]);
    if (!values["run-id"]) throw new Error("run status requires --run-id");
    return {
      command: "run-status",
      runId: values["run-id"],
      ...(values.json ? { json: true } : {}),
    };
  }
  if (command === "run") {
    rejectOptions(values, [
      "issue",
      "owner",
      "repo",
      "base-ref",
      "tag",
      "identity",
      "timeout-seconds",
    ]);
    if (!values.issue || !values.owner || !values.repo || !values["base-ref"] || !values.tag)
      throw new Error("--issue, --owner, --repo, --base-ref, and --tag are required");
    const identity = values.identity ?? process.env.FACTORY_EXE_IDENTITY;
    if (identity && (!isAbsolute(identity) || identity.includes("\0")))
      throw new Error("exe.dev identity must be an absolute path");
    return {
      issue: values.issue,
      owner: values.owner,
      repo: values.repo,
      baseRef: values["base-ref"],
      tag: values.tag,
      timeoutSeconds: timeout(values["timeout-seconds"], "900"),
      ...(identity ? { identity } : {}),
    };
  }
  if (command === "pi worker") {
    rejectOptions(values, [
      "repo",
      "issue",
      "model",
      "planner",
      "base-sha",
      "timeout-seconds",
      "machine",
    ]);
    if (!values.repo || !values.issue || !values.model || !values.planner || !values["base-sha"])
      throw new Error("--repo, --issue, --planner, --base-sha, and --model are required");
    return {
      repo: values.repo,
      issue: values.issue,
      plannerEnvelope: values.planner,
      baseSha: values["base-sha"],
      model: values.model,
      timeoutSeconds: timeout(values["timeout-seconds"], "300"),
      ...(values.machine ? { machine: true } : {}),
    };
  }
  if (command !== "pi plan")
    throw new Error(
      "Expected command: agents list, setup, doctor, pi plan, pi worker, run, run start, run status, dashboard, or observer",
    );
  rejectOptions(values, ["repo", "issue", "model", "timeout-seconds", "machine"]);
  if (!values.repo || !values.issue || !values.model)
    throw new Error("--repo, --issue, and --model are required");
  return {
    repo: values.repo,
    issue: values.issue,
    model: values.model,
    timeoutSeconds: timeout(values["timeout-seconds"], "300"),
    ...(values.machine ? { machine: true } : {}),
  };
}

export function agentExitCode(
  status: "completed" | "failed" | "timed_out",
  machine: boolean,
): number {
  if (machine) return 0;
  return status === "timed_out" ? 124 : status === "completed" ? 0 : 1;
}

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function writeHumanStart(root: string, runId: string): Promise<void> {
  process.stdout.write(`Run: ${runId}\nStatus: running\n`);
  const observer = await observerStatus(root);
  if (observer) process.stdout.write(`Observer: ${observer.url}/runs/${runId}\n`);
  else process.stdout.write("Start dashboard with: factory dashboard\n");
}

function writeHumanStatus(status: RunStatusSummary): void {
  process.stdout.write(
    [
      `Run: ${status.runId}`,
      `Status: ${status.status}`,
      `Phase: ${status.phase ?? "-"}`,
      `Actor: ${status.actor ?? "-"}`,
      `Tool: ${status.currentTool ?? "-"}`,
      `Cleanup: ${status.cleanup ?? "-"}`,
      `Last activity: ${status.lastActivity ?? "-"}`,
      status.failure ? `Failure: ${status.failure.code} ${status.failure.message}` : undefined,
      status.pullRequest ? `Pull request: ${status.pullRequest.url}` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n") + "\n",
  );
}

function takeControllerEnvironment(): {
  linearToken: string | undefined;
  githubToken: string | undefined;
  identity: string | undefined;
  instanceId: string | undefined;
} {
  const result = {
    linearToken: process.env.LINEAR_API_TOKEN,
    githubToken: process.env.GITHUB_TOKEN,
    identity: process.env.FACTORY_EXE_IDENTITY,
    instanceId: process.env.FACTORY_LAUNCH_INSTANCE_ID,
  };
  delete process.env.LINEAR_API_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.FACTORY_EXE_IDENTITY;
  delete process.env.FACTORY_LAUNCH_INSTANCE_ID;
  return result;
}

function publicJsonError(message: string): string {
  const safe = [
    /^--[a-z-]+.*required$/,
    /^--timeout-seconds must/,
    /^invalid /,
    /^target /,
    /^cannot inspect target Git repository$/,
    /^LINEAR_API_TOKEN(?: and GITHUB_TOKEN are required| is required)$/,
    /^GITHUB_TOKEN is required$/,
    /^GitHub CLI auth is unavailable$/,
    /^1Password reference could not be read$/,
    /^invalid Linear token reference$/,
    /^invalid factory config$/,
    /^SSH_AUTH_SOCK is invalid$/,
    /^exe\.dev identity must be an absolute path$/,
    /^controller child (?:could not start|rejected startup)$/,
    /^controller child termination unconfirmed for run [0-9a-f-]{36}$/,
    /^observer /,
    /^--port must/,
  ];
  return safe.some((pattern) => pattern.test(message)) ? message : "factory command failed";
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseCli(args);
    if (options === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (options === "list-agents") {
      for (const agent of listAgents())
        process.stdout.write(
          `${agent.name}\t${agent.access}\t${agent.description}\t[${agent.tools.join(", ")}]\n`,
        );
      return 0;
    }
    const root = factoryRoot(import.meta.dirname);
    if ("command" in options) {
      if (options.command === "setup") {
        const result = await runSetup({
          json: options.json,
          linearTokenReference: options.linearTokenReference,
          installSkill: options.installSkill,
          factoryRoot: root,
        });
        if (options.json) return result.ok ? 0 : 1;
        return 0;
      }
      if (options.command === "doctor") {
        const result = await runDoctor({
          json: options.json,
          target: options.target,
          factoryRoot: root,
        });
        return result.ok ? 0 : 1;
      }
      if (options.command === "observer-serve") {
        const instanceId = process.env.FACTORY_OBSERVER_INSTANCE_ID ?? randomUUID();
        delete process.env.FACTORY_OBSERVER_INSTANCE_ID;
        await serveObserver({ root, port: options.port, instanceId });
        return 0;
      }
      if (options.command === "dashboard" || options.command === "observer-ensure") {
        const cliPath = process.argv[1];
        if (!cliPath) throw new Error("observer CLI path unavailable");
        const observer = await ensureObserver({
          root,
          port: options.port,
          cliPath,
          env: process.env,
        });
        if (options.command === "observer-ensure") json({ version: 1, ok: true, observer });
        else process.stdout.write(`Dashboard: ${observer.url}\n`);
        return 0;
      }
      if (options.command === "observer-status") {
        const observer = await observerStatus(root);
        json({ version: 1, ok: true, running: Boolean(observer), observer: observer ?? null });
        return observer ? 0 : 1;
      }
      if (options.command === "observer-stop") {
        const stopped = await stopObserver(root);
        json({ version: 1, ok: true, stopped: true, observer: stopped });
        return 0;
      }
      if (options.command === "run-start") {
        const launchEnv = { ...process.env };
        const credentials = await resolveControllerCredentials({
          env: launchEnv,
          identityFlag: options.identity,
          config: loadFactoryConfig({ env: launchEnv }),
        });
        const result = await startDetachedRun({
          ...options,
          factoryRoot: root,
          cliPath: process.argv[1],
          env: {
            ...launchEnv,
            LINEAR_API_TOKEN: credentials.linearToken,
            GITHUB_TOKEN: credentials.githubToken,
            ...(credentials.identity ? { FACTORY_EXE_IDENTITY: credentials.identity } : {}),
          },
          ...(credentials.identity ? { identity: credentials.identity } : { identity: undefined }),
        });
        delete process.env.LINEAR_API_TOKEN;
        delete process.env.GITHUB_TOKEN;
        delete process.env.GH_TOKEN;
        delete process.env.FACTORY_EXE_IDENTITY;
        if (options.json) json(result);
        else await writeHumanStart(root, result.runId);
        return 0;
      }
      if (options.command === "run-status") {
        const status = foldRunStatus({
          root,
          runId: options.runId,
          controllerExists: (runId) =>
            existsSync(resolve(root, ".factory", "controllers", runId, "controller-state.json")),
        });
        if (options.json) json(status);
        else writeHumanStatus(status);
        return 0;
      }
      if (options.command !== "run-execute") throw new Error("invalid observer command");
      const { linearToken, githubToken, identity, instanceId } = takeControllerEnvironment();
      if (!linearToken || !githubToken || !instanceId)
        throw new Error("controller child environment is incomplete");
      const target = validateResolvedTarget({
        owner: options.owner,
        repo: options.repo,
        baseRef: options.baseRef,
        tag: options.tag,
      });
      const result = await runController({
        issue: options.issue,
        owner: target.owner,
        repo: target.repo,
        baseRef: target.baseRef,
        tag: target.tag,
        timeoutSeconds: options.timeoutSeconds,
        linearToken,
        githubToken,
        root,
        factoryRoot: root,
        runId: options.runId,
        onAccepted: () => writeLaunchHandshake(root, options.runId, instanceId),
        ...(identity ? { identity } : {}),
      });
      process.stdout.write(`Controller evidence: ${result.runDir}\n`);
      return result.status === "completed" ? 0 : 1;
    }
    if ("baseRef" in options) {
      const launchEnv = { ...process.env };
      const credentials = await resolveControllerCredentials({
        env: launchEnv,
        identityFlag: options.identity,
        config: loadFactoryConfig({ env: launchEnv }),
      });
      const result = await runController({
        ...options,
        linearToken: credentials.linearToken,
        githubToken: credentials.githubToken,
        ...(credentials.identity ? { identity: credentials.identity } : {}),
      });
      process.stdout.write(`\nController evidence: ${result.runDir}\n`);
      return result.status === "completed" ? 0 : 1;
    }
    const protocol = options.machine
      ? createRemoteProtocolWriter((line) => process.stdout.write(line))
      : undefined;
    const result =
      "plannerEnvelope" in options
        ? await runWorkerLifecycle({
            repo: options.repo,
            issue: options.issue,
            plannerEnvelope: options.plannerEnvelope,
            baseSha: options.baseSha,
            model: options.model,
            timeoutSeconds: options.timeoutSeconds,
            onEvent: protocol ? (event) => protocol.event(event) : undefined,
          })
        : await runPlan({
            ...options,
            onEvent: protocol ? (event) => protocol.event(event) : undefined,
          });
    if (protocol) {
      protocol.result({
        status: result.status,
        runDir: result.runDir,
        ...("reviewerRunDir" in result && typeof result.reviewerRunDir === "string"
          ? { reviewerRunDir: result.reviewerRunDir }
          : {}),
      });
    } else {
      process.stdout.write(`\nRun evidence: ${result.runDir}\n`);
      if ("reviewerRunDir" in result && typeof result.reviewerRunDir === "string")
        process.stdout.write(`Reviewer evidence: ${result.reviewerRunDir}\n`);
    }
    return agentExitCode(result.status, Boolean(protocol));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes("--json")) {
      const terminationUnconfirmed = message.startsWith(
        "controller child termination unconfirmed for run ",
      );
      json({
        version: 1,
        ok: false,
        error: {
          code: terminationUnconfirmed ? "termination_unconfirmed" : "command_failed",
          message: publicJsonError(message),
        },
      });
      return 1;
    }
    process.stderr.write(`${message}\n\n${HELP}`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
