import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
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
import type { AgentDefinition } from "./agents/index.js";
import {
  createSubmitEnvelopeTool,
  envelopeCorrectionPrompt,
  parseEnvelope,
  type Envelope,
  type EnvelopeCapture,
  type EnvelopeRole,
} from "./envelope.js";
import type { RunArtifacts } from "./run-artifacts.js";

export type AgentRunStatus = "completed" | "failed" | "timed_out";

export interface EnvelopeReceipt {
  role: EnvelopeRole;
  valid: boolean;
  correctionAttempts: number;
  /** Run-relative path of the validated envelope; set only when valid. */
  path?: string;
  /** Validation errors; set only when invalid. */
  errors?: string[];
}

export interface AgentReceipt {
  runId: string;
  status: AgentRunStatus;
  startedAt: string;
  finishedAt?: string;
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
  envelope?: EnvelopeReceipt;
  error?: string;
}

export type RunReceipt = AgentReceipt & Record<string, unknown>;

/**
 * Validation seam for artifact names returned by onCompleted: each must be a
 * plain basename (no path segments) that exists inside runDir.
 */
export function runArtifactNameErrors(names: string[], runDir: string): string[] {
  const errors: string[] = [];
  for (const name of names) {
    if (!name || name === "." || name === ".." || name !== basename(name)) {
      errors.push(`unsafe artifact name: ${JSON.stringify(name)}`);
    } else if (!existsSync(join(runDir, name))) {
      errors.push(`artifact does not exist in runDir: ${name}`);
    }
  }
  return errors;
}

export type AgentActivity =
  | { type: "agent_started"; at: string }
  | { type: "agent_finished"; at: string; status: "completed" | "failed" | "timed_out" }
  | {
      type: "agent_usage";
      at: string;
      tokens: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
      reportedCostNanoUsd?: number;
    }
  | { type: "tool_started"; at: string; toolCallId: string; toolName: string }
  | {
      type: "tool_finished";
      at: string;
      toolCallId: string;
      toolName: string;
      isError: boolean;
    };

export function tokenUsageActivity(
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number },
  at = new Date().toISOString(),
  cost?: number,
): Extract<AgentActivity, { type: "agent_usage" }> {
  const nanoUsd = cost === undefined ? undefined : cost * 1_000_000_000;
  return {
    type: "agent_usage",
    at,
    tokens: { ...tokens },
    ...(Number.isFinite(nanoUsd) && nanoUsd! >= 0 && Number.isSafeInteger(Math.round(nanoUsd!))
      ? { reportedCostNanoUsd: Math.round(nanoUsd!) }
      : {}),
  };
}

export interface RunAgentOptions {
  agent: AgentDefinition;
  cwd: string;
  timeoutSeconds: number;
  prompt: string;
  artifacts: RunArtifacts;
  receiptContext?: Record<string, unknown>;
  /** When set, the agent must submit a valid role envelope via submit_envelope as its final action. */
  envelopeRole?: EnvelopeRole;
  onTextDelta?: (delta: string) => void;
  onActivity?: (activity: AgentActivity) => void;
  onCompleted?: (
    finalText: string,
    artifacts: RunArtifacts,
    envelope?: Envelope,
  ) => string[] | void | Promise<string[] | void>;
}

export interface AgentRunResult {
  status: AgentRunStatus;
  runDir: string;
  finalText: string;
  /** Validated role envelope; set only on completed envelope-mode runs. */
  envelope?: Envelope;
  receipt: RunReceipt;
}

function privatizeSessionFiles(path: string): void {
  if (!existsSync(path)) return;
  const metadata = statSync(path);
  chmodSync(path, metadata.isDirectory() ? 0o700 : 0o600);
  if (metadata.isDirectory())
    for (const name of readdirSync(path)) privatizeSessionFiles(join(path, name));
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
  const message = session.messages.toReversed().find((candidate) => candidate.role === "assistant");
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const { agent, artifacts } = options;
  const envelopeRole = options.envelopeRole;
  const effectiveTools = envelopeRole ? [...agent.tools, "submit_envelope"] : agent.tools;
  const receipt: RunReceipt = {
    runId: artifacts.runId,
    status: "failed",
    startedAt: new Date().toISOString(),
    ...options.receiptContext,
    model: agent.model,
    timeoutSeconds: options.timeoutSeconds,
    agent: {
      name: agent.name,
      description: agent.description,
      tools: effectiveTools,
      thinking: agent.thinking,
      access: agent.access,
    },
    artifacts: ["issue.md", "events.jsonl", "receipt.json"],
  };

  let session: AgentSession | undefined;
  let timedOut = false;
  let promptSettled = false;
  let abortPromise: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let finalText = "";
  let envelope: Envelope | undefined;
  let correctionAttempts = 0;

  try {
    const modelRuntime = await ModelRuntime.create();
    const resolvedModel = resolveCliModel({
      cliModel: agent.model,
      cliThinking: agent.thinking,
      modelRuntime,
    });
    if (!resolvedModel.model)
      throw new Error(resolvedModel.error ?? `Unknown model: ${agent.model}`);
    const thinkingLevel = resolvedModel.thinkingLevel ?? agent.thinking;
    receipt.agent.thinking = thinkingLevel;
    if (!(await modelRuntime.getAuth(resolvedModel.model))) {
      throw new Error(`No authentication configured for provider: ${resolvedModel.model.provider}`);
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });
    const capture: EnvelopeCapture = { calls: 0 };
    const created = await createAgentSession({
      cwd: options.cwd,
      model: resolvedModel.model,
      thinkingLevel,
      modelRuntime,
      resourceLoader: isolatedResources(agent.systemPrompt),
      tools: effectiveTools,
      customTools: envelopeRole ? [createSubmitEnvelopeTool(envelopeRole, capture)] : undefined,
      sessionManager: SessionManager.create(options.cwd, artifacts.sessionsDir),
      settingsManager,
    });
    session = created.session;
    receipt.sessionId = session.sessionId;

    const unsubscribe = session.subscribe((event) => {
      const record = eventRecord(event);
      if (record) artifacts.appendEvent(record);
      const at = new Date().toISOString();
      if (event.type === "tool_execution_start")
        options.onActivity?.({
          type: "tool_started",
          at,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        });
      if (event.type === "tool_execution_end")
        options.onActivity?.({
          type: "tool_finished",
          at,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
        });
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        options.onTextDelta?.(event.assistantMessageEvent.delta);
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

    const captureEnvelope = ():
      | { ok: true; envelope: Envelope }
      | { ok: false; errors: string[] } =>
      capture.calls > 0
        ? parseEnvelope(envelopeRole!, capture.value)
        : { ok: false, errors: ["submit_envelope tool was not called"] };

    options.onActivity?.({ type: "agent_started", at: new Date().toISOString() });
    try {
      await session.prompt(options.prompt);
      if (envelopeRole && !timedOut) {
        // The SDK schema check alone is not acceptance: semantics are revalidated here.
        let parsed = captureEnvelope();
        if (!parsed.ok) {
          correctionAttempts = 1;
          artifacts.appendEvent({
            at: new Date().toISOString(),
            type: "envelope_invalid",
            role: envelopeRole,
            errors: parsed.errors,
          });
          await session.prompt(envelopeCorrectionPrompt(envelopeRole, parsed.errors));
          if (!timedOut) parsed = captureEnvelope();
        }
        if (!timedOut) {
          if (parsed.ok) {
            envelope = parsed.envelope;
            artifacts.appendEvent({
              at: new Date().toISOString(),
              type: "envelope_accepted",
              role: envelopeRole,
              correctionAttempts,
            });
          } else {
            artifacts.appendEvent({
              at: new Date().toISOString(),
              type: "envelope_rejected",
              role: envelopeRole,
              errors: parsed.errors,
            });
            receipt.envelope = {
              role: envelopeRole,
              valid: false,
              correctionAttempts,
              errors: parsed.errors,
            };
            throw new Error(
              `${envelopeRole} envelope missing or invalid after one correction attempt`,
            );
          }
        }
      }
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
    } else if (envelopeRole) {
      finalText = finalAssistantText(session);
      const extraArtifacts = await options.onCompleted?.(finalText, artifacts, envelope);
      if (extraArtifacts) {
        const nameErrors = runArtifactNameErrors(extraArtifacts, artifacts.runDir);
        if (nameErrors.length)
          throw new Error(`onCompleted returned invalid artifacts: ${nameErrors.join("; ")}`);
        receipt.artifacts.push(...extraArtifacts);
      }
      artifacts.writeJson("envelope.json", envelope!);
      receipt.envelope = {
        role: envelopeRole,
        valid: true,
        correctionAttempts,
        path: "envelope.json",
      };
      receipt.artifacts.push("envelope.json");
      receipt.status = "completed";
    } else {
      finalText = finalAssistantText(session);
      if (!finalText) {
        throw new Error(
          `${agent.name.charAt(0).toUpperCase()}${agent.name.slice(1)} returned no text`,
        );
      }
      const extraArtifacts = await options.onCompleted?.(finalText, artifacts);
      if (extraArtifacts) {
        const nameErrors = runArtifactNameErrors(extraArtifacts, artifacts.runDir);
        if (nameErrors.length)
          throw new Error(`onCompleted returned invalid artifacts: ${nameErrors.join("; ")}`);
        receipt.artifacts.push(...extraArtifacts);
      }
      receipt.status = "completed";
    }
  } catch (error) {
    receipt.status = timedOut ? "timed_out" : "failed";
    receipt.error = error instanceof Error ? error.message : String(error);
    // A failed or timed-out run must not expose a public result envelope.
    envelope = undefined;
  } finally {
    if (timer) clearTimeout(timer);
    if (session) {
      receipt.sessionFile ??= session.sessionFile;
      receipt.stats ??= session.getSessionStats();
      options.onActivity?.({
        type: "agent_finished",
        at: new Date().toISOString(),
        status: receipt.status,
      });
      if (receipt.status === "completed")
        options.onActivity?.(
          tokenUsageActivity(receipt.stats.tokens, undefined, receipt.stats.cost),
        );
      session.dispose();
    }
    privatizeSessionFiles(artifacts.sessionsDir);
    receipt.finishedAt = new Date().toISOString();
    artifacts.writeJson("receipt.json", receipt);
  }

  return { status: receipt.status, runDir: artifacts.runDir, finalText, envelope, receipt };
}
