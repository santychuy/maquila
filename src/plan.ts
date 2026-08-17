import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { loadAgent } from "./agents.js";
import { createRunArtifacts } from "./run-artifacts.js";

export const MAX_TIMEOUT_SECONDS = 1800;

export interface PlanOptions {
  repo: string;
  issue: string;
  model: string;
  timeoutSeconds: number;
}

export type PlanStatus = "completed" | "failed" | "timed_out";

export interface PlanResult {
  runDir: string;
  status: PlanStatus;
}

interface Receipt {
  runId: string;
  status: PlanStatus;
  startedAt: string;
  finishedAt?: string;
  repo: string;
  baseSha: string;
  repoWasDirty: boolean;
  issueSha256: string;
  model: string;
  timeoutSeconds: number;
  agent: {
    name: string;
    description: string;
    tools: string[];
    thinking: string;
    access: "read-only" | "writer";
  };
  sessionId?: string;
  sessionFile?: string;
  stats?: ReturnType<AgentSession["getSessionStats"]>;
  artifacts: string[];
  error?: string;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}

function validateFile(path: string): void {
  if (!statSync(path).isFile()) throw new Error(`Not a file: ${path}`);
}

function validateRepo(path: string): void {
  if (!statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`);
  git(path, "rev-parse", "--is-inside-work-tree");
}

function isolatedResources(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function eventRecord(event: AgentSessionEvent): object | undefined {
  const at = new Date().toISOString();
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "agent_settled":
      return { at, type: event.type };
    case "agent_end":
      return { at, type: event.type, willRetry: event.willRetry };
    case "tool_execution_start":
      return { at, type: event.type, toolCallId: event.toolCallId, toolName: event.toolName };
    case "tool_execution_end":
      return {
        at,
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };
    case "message_end":
      return event.message.role === "assistant"
        ? {
            at,
            type: event.type,
            stopReason: event.message.stopReason,
            usage: event.message.usage,
          }
        : undefined;
    case "auto_retry_start":
      return { at, type: event.type, attempt: event.attempt, maxAttempts: event.maxAttempts };
    case "auto_retry_end":
      return { at, type: event.type, success: event.success, attempt: event.attempt };
    default:
      return undefined;
  }
}

function finalAssistantText(session: AgentSession): string {
  const message = [...session.messages].reverse().find((candidate) => candidate.role === "assistant");
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export async function runPlan(options: PlanOptions): Promise<PlanResult> {
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 1 || options.timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`);
  }

  const repo = resolve(options.repo);
  const issuePath = resolve(options.issue);
  validateRepo(repo);
  validateFile(issuePath);

  const issue = readFileSync(issuePath, "utf8");
  const planner = loadAgent("planner");
  const artifacts = createRunArtifacts(issue);
  const receipt: Receipt = {
    runId: artifacts.runId,
    status: "failed",
    startedAt: new Date().toISOString(),
    repo,
    baseSha: git(repo, "rev-parse", "HEAD"),
    repoWasDirty: git(repo, "status", "--porcelain").length > 0,
    issueSha256: createHash("sha256").update(issue).digest("hex"),
    model: options.model,
    timeoutSeconds: options.timeoutSeconds,
    agent: {
      name: planner.name,
      description: planner.description,
      tools: planner.tools,
      thinking: planner.thinking,
      access: planner.access,
    },
    artifacts: ["issue.md", "events.jsonl", "receipt.json"],
  };

  let session: AgentSession | undefined;
  let timedOut = false;
  let promptSettled = false;
  let abortPromise: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;

  try {
    const modelRuntime = await ModelRuntime.create();
    const resolvedModel = resolveCliModel({
      cliModel: options.model,
      cliThinking: planner.thinking,
      modelRuntime,
    });
    if (!resolvedModel.model) throw new Error(resolvedModel.error ?? `Unknown model: ${options.model}`);
    const thinkingLevel = resolvedModel.thinkingLevel ?? planner.thinking;
    receipt.agent.thinking = thinkingLevel;
    if (!(await modelRuntime.getAuth(resolvedModel.model))) {
      throw new Error(`No authentication configured for provider: ${resolvedModel.model.provider}`);
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });
    const created = await createAgentSession({
      cwd: repo,
      model: resolvedModel.model,
      thinkingLevel,
      modelRuntime,
      resourceLoader: isolatedResources(planner.systemPrompt),
      tools: planner.tools,
      sessionManager: SessionManager.create(repo, artifacts.sessionsDir),
      settingsManager,
    });
    session = created.session;
    receipt.sessionId = session.sessionId;

    const unsubscribe = session.subscribe((event) => {
      const record = eventRecord(event);
      if (record) artifacts.appendEvent(record);
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
    });

    timer = setTimeout(() => {
      if (promptSettled) return;
      timedOut = true;
      artifacts.appendEvent({ at: new Date().toISOString(), type: "deadline_reached" });
      abortPromise = session!.abort().catch((error: unknown) => {
        artifacts.appendEvent({
          at: new Date().toISOString(),
          type: "abort_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, options.timeoutSeconds * 1000);

    try {
      await session.prompt(`Plan this issue. Do not modify the repository.\n\n${issue}`);
    } catch (error) {
      if (!timedOut) throw error;
    } finally {
      promptSettled = true;
      clearTimeout(timer);
      if (abortPromise) await abortPromise;
      unsubscribe();
    }

    receipt.sessionFile = session.sessionFile;
    receipt.stats = session.getSessionStats();

    if (timedOut) {
      receipt.status = "timed_out";
    } else {
      const plan = finalAssistantText(session);
      if (!plan) throw new Error("Planner returned no text");
      artifacts.write("plan.md", `${plan}\n`);
      receipt.artifacts.push("plan.md");
      receipt.status = "completed";
    }
  } catch (error) {
    receipt.status = timedOut ? "timed_out" : "failed";
    receipt.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (timer) clearTimeout(timer);
    if (session) {
      receipt.sessionFile ??= session.sessionFile;
      receipt.stats ??= session.getSessionStats();
      session.dispose();
    }
    receipt.finishedAt = new Date().toISOString();
    artifacts.writeJson("receipt.json", receipt);
  }

  return { runDir: artifacts.runDir, status: receipt.status };
}
