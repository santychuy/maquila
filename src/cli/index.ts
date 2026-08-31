#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { listAgents } from "../agents/index.js";
import { runPlan } from "../workflows/plan.js";
import { runWorkerLifecycle } from "../workflows/worker.js";
import { runControllerChain } from "../controller-chain.js";
import { runBuiltInMaquila } from "./maquila-runtime.js";
import { readPersistedDecisionRequest } from "../controller.js";
import { createRemoteProtocolWriter } from "../remote-protocol.js";
import { loadMaquilaConfig } from "../config.js";
import { resolveControllerCredentials } from "../credentials.js";
import { runDoctor } from "../doctor.js";
import { runSetup, SetupCancelled } from "../setup.js";
import { LAUNCH_INSTANCE_ENV, startDetachedRun, writeLaunchHandshake } from "../run-launcher.js";
import {
  createBatch,
  readBatchState,
  runBatch,
  startDetachedBatch,
  type BatchState,
} from "../run-batch.js";
import { foldRunStatus, type RunStatusSummary } from "../run-status.js";
import { maquilaRoot, isMain } from "../runtime.js";
import { resolveTargetRepository, validateResolvedTarget } from "../target.js";
import {
  ensureObserver,
  observerStatus,
  serveObserver,
  stopObserver,
} from "../observer/process.js";
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

function writeHumanBatch(state: BatchState): void {
  process.stdout.write(`Batch: ${state.batchId}\nStatus: ${state.status}\n`);
  for (const item of state.items)
    process.stdout.write(`${item.issue}: ${item.runId} ${item.status}\n`);
}

async function writeHumanStart(root: string, runId: string): Promise<void> {
  process.stdout.write(`Run: ${runId}\nStatus: running\n`);
  const observer = await observerStatus(root);
  if (observer) process.stdout.write(`Observer: ${observer.url}/runs/${runId}\n`);
  else process.stdout.write("Start dashboard with: maquila dashboard\n");
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
      status.decision ? `Decision: ${status.decision.commentUrl}` : undefined,
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
  const identity = process.env.MAQUILA_EXE_IDENTITY;
  const instanceId = process.env[LAUNCH_INSTANCE_ENV];
  delete process.env.LINEAR_API_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.MAQUILA_EXE_IDENTITY;
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
    /^invalid maquila config$/,
    /^SSH_AUTH_SOCK is invalid$/,
    /^exe\.dev identity must be an absolute path$/,
    /^controller child (?:could not start|rejected startup)$/,
    /^controller child termination unconfirmed for run [0-9a-f-]{36}$/,
    /^batch (?:requires|coordinator)/,
    /^invalid batch/,
    /^observer /,
    /^--port must/,
  ];
  return safe.some((pattern) => pattern.test(message)) ? message : "maquila command failed";
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

    const root = maquilaRoot(import.meta.dirname);

    if ("command" in options) {
      if (options.command === "setup") {
        const result = await runSetup({
          json: options.json,
          linearTokenReference: options.linearTokenReference,
          openRouterTokenReference: options.openRouterTokenReference,
          installSkill: options.installSkill,
          target: options.target,
          identity: options.identity,
          maquilaRoot: root,
        });
        return result.ok ? 0 : 1;
      }
      if (options.command === "doctor") {
        const result = await runDoctor({
          json: options.json,
          target: options.target,
          identity: options.identity,
          maquilaRoot: root,
        });
        return result.ok ? 0 : 1;
      }
      if (options.command === "observer-serve") {
        const instanceId = process.env.MAQUILA_OBSERVER_INSTANCE_ID ?? randomUUID();
        delete process.env.MAQUILA_OBSERVER_INSTANCE_ID;
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
      if (options.command === "run-batch-status") {
        const state = readBatchState(root, options.batchId);
        if (options.json) json(state);
        else writeHumanBatch(state);
        return 0;
      }
      if (options.command === "run-batch") {
        const launchEnv = { ...process.env };
        const credentials = await resolveControllerCredentials({
          env: launchEnv,
          identityFlag: options.identity,
          config: loadMaquilaConfig({ env: launchEnv }),
        });
        const target = resolveTargetRepository({
          target: options.target,
          ...(options.owner ? { owner: options.owner } : {}),
          ...(options.repo ? { repo: options.repo } : {}),
          ...(options.baseRef ? { baseRef: options.baseRef } : {}),
          ...(options.tag ? { tag: options.tag } : {}),
        });
        const state = createBatch({
          root,
          issues: options.issues,
          target: {
            owner: target.owner,
            repo: target.repo,
            baseRef: target.baseRef,
            tag: target.tag,
          },
          timeoutSeconds: options.timeoutSeconds,
        });
        const result = await startDetachedBatch({
          root,
          batchId: state.batchId,
          cliPath: process.argv[1],
          env: {
            ...launchEnv,
            LINEAR_API_TOKEN: credentials.linearToken,
            GITHUB_TOKEN: credentials.githubToken,
            OPENROUTER_API_KEY: credentials.openRouterKey,
            ...(credentials.identity ? { MAQUILA_EXE_IDENTITY: credentials.identity } : {}),
          },
          ...(credentials.identity ? { identity: credentials.identity } : {}),
        });
        delete process.env.LINEAR_API_TOKEN;
        delete process.env.GITHUB_TOKEN;
        delete process.env.GH_TOKEN;
        delete process.env.OPENROUTER_API_KEY;
        delete process.env.MAQUILA_EXE_IDENTITY;
        if (options.json) json(result);
        else writeHumanBatch(readBatchState(root, state.batchId));
        return 0;
      }
      if (options.command === "run-start") {
        const launchEnv = { ...process.env };
        const credentials = await resolveControllerCredentials({
          env: launchEnv,
          identityFlag: options.identity,
          config: loadMaquilaConfig({ env: launchEnv }),
        });
        const result = await startDetachedRun({
          ...options,
          maquilaRoot: root,
          cliPath: process.argv[1],
          env: {
            ...launchEnv,
            LINEAR_API_TOKEN: credentials.linearToken,
            GITHUB_TOKEN: credentials.githubToken,
            OPENROUTER_API_KEY: credentials.openRouterKey,
            ...(credentials.identity ? { MAQUILA_EXE_IDENTITY: credentials.identity } : {}),
          },
          ...(credentials.identity ? { identity: credentials.identity } : { identity: undefined }),
        });
        delete process.env.LINEAR_API_TOKEN;
        delete process.env.GITHUB_TOKEN;
        delete process.env.GH_TOKEN;
        delete process.env.OPENROUTER_API_KEY;
        delete process.env.MAQUILA_EXE_IDENTITY;
        if (options.json) json(result);
        else await writeHumanStart(root, result.runId);
        return 0;
      }
      if (options.command === "run-resume") {
        const credentials = await resolveControllerCredentials({
          env: process.env,
          identityFlag: options.identity,
          config: loadMaquilaConfig({ env: process.env }),
        });
        const runDir = resolve(root, ".maquila", "controllers", options.runId);
        const persisted = readPersistedDecisionRequest(runDir);
        const result = await runControllerChain({
          ...persisted.request,
          runId: options.runId,
          root,
          maquilaRoot: root,
          linearToken: credentials.linearToken,
          githubToken: credentials.githubToken,
          openRouterKey: credentials.openRouterKey,
          resumeExisting: true,
          ...(credentials.identity ? { identity: credentials.identity } : {}),
        });
        if (options.json) json(result);
        else process.stdout.write(`Controller evidence: ${result.runDir}\n`);
        return result.status === "completed" ? 0 : 1;
      }
      if (options.command === "run-status") {
        const status = foldRunStatus({
          root,
          runId: options.runId,
          controllerExists: (runId) =>
            existsSync(resolve(root, ".maquila", "controllers", runId, "controller-state.json")),
        });
        if (options.json) json(status);
        else writeHumanStatus(status);
        return 0;
      }
      if (options.command === "run-batch-execute") {
        const { linearToken, githubToken, openRouterKey, identity, instanceId } =
          takeControllerEnvironment();
        if (!linearToken || !githubToken || !openRouterKey || !instanceId)
          throw new Error("batch coordinator environment is incomplete");
        const result = await runBatch({
          root,
          maquilaRoot: root,
          batchId: options.batchId,
          linearToken,
          githubToken,
          openRouterKey,
          ...(identity ? { identity } : {}),
          onAccepted: () => writeLaunchHandshake(root, options.batchId, instanceId),
        });
        writeHumanBatch(result);
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
      const result = await runBuiltInMaquila(
        root,
        { linearToken, githubToken, openRouterKey, ...(identity ? { identity } : {}) },
        {
          issue: options.issue,
          owner: target.owner,
          repo: target.repo,
          baseRef: target.baseRef,
          tag: target.tag,
          timeoutSeconds: options.timeoutSeconds,
        },
        {
          runId: options.runId,
          maquilaRoot: root,
          onAccepted: () => writeLaunchHandshake(root, options.runId, instanceId),
        },
      );
      process.stdout.write(`Controller evidence: ${result.runDirectory}\n`);
      return result.status === "completed" ? 0 : 1;
    }
    if ("baseRef" in options) {
      const launchEnv = { ...process.env };
      const credentials = await resolveControllerCredentials({
        env: launchEnv,
        identityFlag: options.identity,
        config: loadMaquilaConfig({ env: launchEnv }),
      });
      const result = await runBuiltInMaquila(
        root,
        {
          linearToken: credentials.linearToken,
          githubToken: credentials.githubToken,
          openRouterKey: credentials.openRouterKey,
          ...(credentials.identity ? { identity: credentials.identity } : {}),
        },
        options,
        { maquilaRoot: root },
      );
      process.stdout.write(`\nController evidence: ${result.runDirectory}\n`);
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
            ...(options.workflowManifest ? { workflowManifest: options.workflowManifest } : {}),
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
        ...("failure" in result && result.failure ? { failure: result.failure } : {}),
      });
    } else {
      process.stdout.write(`\nRun evidence: ${result.runDir}\n`);
      if ("reviewerRunDir" in result && typeof result.reviewerRunDir === "string")
        process.stdout.write(`Reviewer evidence: ${result.reviewerRunDir}\n`);
    }
    return agentExitCode(result.status, Boolean(protocol));
  } catch (error) {
    if (error instanceof SetupCancelled) return 130;
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
