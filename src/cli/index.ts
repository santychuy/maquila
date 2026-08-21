#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { listAgents } from "../agents/index.js";
import { runPlan } from "../workflows/plan.js";
import { runWorkerLifecycle } from "../workflows/worker.js";
import { runController } from "../controller.js";
import { createRemoteProtocolWriter } from "../remote-protocol.js";
import { loadFactoryConfig } from "../config.js";
import { resolveControllerCredentials } from "../credentials.js";
import { runDoctor } from "../doctor.js";
import { runSetup } from "../setup.js";
import { LAUNCH_INSTANCE_ENV, startDetachedRun, writeLaunchHandshake } from "../run-launcher.js";
import { foldRunStatus, type RunStatusSummary } from "../run-status.js";
import { factoryRoot, isMain } from "../runtime.js";
import { validateResolvedTarget } from "../target.js";
import { ensureObserver, observerStatus, serveObserver, stopObserver } from "../observer.js";
import { parseCli } from "./parse.js";
import { HELP } from "./types.js";

export { HELP };
export { parseCli } from "./parse.js";
export type { ParsedCli } from "./types.js";

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
  openRouterKey: string | undefined;
  identity: string | undefined;
  instanceId: string | undefined;
} {
  const linearToken = process.env.LINEAR_API_TOKEN;
  const githubToken = process.env.GITHUB_TOKEN;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const identity = process.env.FACTORY_EXE_IDENTITY;
  const instanceId = process.env[LAUNCH_INSTANCE_ENV];
  delete process.env.LINEAR_API_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.FACTORY_EXE_IDENTITY;
  delete process.env[LAUNCH_INSTANCE_ENV];
  return { linearToken, githubToken, openRouterKey, identity, instanceId };
}

function publicJsonError(message: string): string {
  const safe = [
    /^unsupported option for command: --[a-z-]+$/,
    /^observer ensure requires --json$/,
    /^observer status requires --json$/,
    /^observer stop requires --json$/,
    /^run status requires --run-id$/,
    /^--[a-z-]+.*required$/,
    /^--timeout-seconds must/,
    /^invalid /,
    /^target /,
    /^cannot inspect target Git repository$/,
    /^LINEAR_API_TOKEN(?: and GITHUB_TOKEN are required| is required)$/,
    /^GITHUB_TOKEN is required$/,
    /^OPENROUTER_API_KEY is required$/,
    /^1Password OpenRouter reference could not be read$/,
    /^invalid OpenRouter token reference$/,
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
          openRouterTokenReference: options.openRouterTokenReference,
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
            OPENROUTER_API_KEY: credentials.openRouterKey,
            ...(credentials.identity ? { FACTORY_EXE_IDENTITY: credentials.identity } : {}),
          },
          ...(credentials.identity ? { identity: credentials.identity } : { identity: undefined }),
        });
        delete process.env.LINEAR_API_TOKEN;
        delete process.env.GITHUB_TOKEN;
        delete process.env.GH_TOKEN;
        delete process.env.OPENROUTER_API_KEY;
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
      const { linearToken, githubToken, openRouterKey, identity, instanceId } =
        takeControllerEnvironment();
      if (!linearToken || !githubToken || !openRouterKey || !instanceId)
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
        openRouterKey,
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
        openRouterKey: credentials.openRouterKey,
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
