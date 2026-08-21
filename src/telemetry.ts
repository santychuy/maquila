import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  truncateSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { estimateReferenceNanoUsd } from "./model-reference.js";

export const MAX_TELEMETRY_LINE_BYTES = 64 * 1024;
export const MAX_TELEMETRY_FILE_BYTES = 32 * 1024 * 1024;
const RUN_ID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const HASH = "^[0-9a-f]{64}$";
const COMMIT_SHA = "^[0-9a-f]{40}$";

const ActorSchema = Type.Union([
  Type.Literal("controller"),
  Type.Literal("planner"),
  Type.Literal("worker"),
  Type.Literal("documenter"),
  Type.Literal("verifier"),
  Type.Literal("reviewer"),
]);
const PhaseNameSchema = Type.Union([
  Type.Literal("intake"),
  Type.Literal("creating_vm"),
  Type.Literal("bootstrapping"),
  Type.Literal("planning"),
  Type.Literal("awaiting_decision"),
  Type.Literal("implementing"),
  Type.Literal("documenting"),
  Type.Literal("verifying"),
  Type.Literal("reviewing"),
  Type.Literal("fixing"),
  Type.Literal("ready_for_publication"),
  Type.Literal("publishing"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
]);
const PhaseSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: PhaseNameSchema,
    attempt: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

function eventSchema<const EventType extends string, Payload extends TSchema>(
  type: EventType,
  payload: Payload,
) {
  return Type.Object(
    {
      version: Type.Literal(1),
      runId: Type.String({ pattern: RUN_ID }),
      seq: Type.Integer({ minimum: 1 }),
      eventId: Type.String({ minLength: 1 }),
      type: Type.Literal(type),
      recordedAt: Type.String({ minLength: 1 }),
      sourceAt: Type.Optional(Type.String({ minLength: 1 })),
      phase: Type.Optional(PhaseSchema),
      actor: ActorSchema,
      payload,
    },
    { additionalProperties: false },
  );
}
const empty = () => Type.Object({}, { additionalProperties: false });
const SafeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const ExecutionLimitsSchema = Type.Object(
  { contextTokens: SafeInteger, maxOutputTokens: SafeInteger },
  { additionalProperties: false },
);
const ModelReferenceSchema = Type.Object(
  {
    source: Type.Object(
      {
        repository: Type.String({
          pattern: "^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
          maxLength: 300,
        }),
        commit: Type.String({ pattern: COMMIT_SHA }),
        path: Type.String({ pattern: "^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+$", maxLength: 500 }),
        sha256: Type.String({ pattern: HASH }),
      },
      { additionalProperties: false },
    ),
    model: Type.String({ minLength: 1, maxLength: 200 }),
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
    capabilities: Type.Object(
      {
        attachments: Type.Boolean(),
        reasoning: Type.Boolean(),
        tools: Type.Boolean(),
        structuredOutput: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    limits: ExecutionLimitsSchema,
    modalities: Type.Object(
      {
        input: Type.Array(
          Type.Union([Type.Literal("text"), Type.Literal("image"), Type.Literal("pdf")]),
          { minItems: 1, maxItems: 3, uniqueItems: true },
        ),
        output: Type.Array(Type.Literal("text"), { minItems: 1, maxItems: 1 }),
      },
      { additionalProperties: false },
    ),
    knowledgeCutoff: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }),
    releaseDate: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }),
    updatedAt: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }),
    status: Type.Optional(
      Type.Union([Type.Literal("alpha"), Type.Literal("beta"), Type.Literal("deprecated")]),
    ),
    pricing: Type.Optional(
      Type.Object(
        {
          mode: Type.Literal("flat"),
          currency: Type.Literal("USD"),
          nanoUsdPerToken: Type.Object(
            {
              input: SafeInteger,
              output: SafeInteger,
              cacheRead: SafeInteger,
              cacheWrite: SafeInteger,
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const statusPayload = Type.Object(
  {
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
    ]),
  },
  { additionalProperties: false },
);

export const TelemetryRecordSchema = Type.Union([
  eventSchema(
    "run_created",
    Type.Object({ status: Type.Literal("created") }, { additionalProperties: false }),
  ),
  eventSchema(
    "run_started",
    Type.Object({ status: Type.Literal("running") }, { additionalProperties: false }),
  ),
  eventSchema("phase_started", empty()),
  eventSchema("phase_finished", statusPayload),
  eventSchema("agent_started", empty()),
  eventSchema("agent_finished", statusPayload),
  eventSchema(
    "agent_context",
    Type.Object(
      {
        model: Type.String({ minLength: 1, maxLength: 200 }),
        description: Type.String({ minLength: 1, maxLength: 1000 }),
        tools: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
          minItems: 1,
          maxItems: 20,
          uniqueItems: true,
        }),
        thinking: Type.Union([
          Type.Literal("off"),
          Type.Literal("minimal"),
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("xhigh"),
          Type.Literal("max"),
        ]),
        access: Type.Union([Type.Literal("read-only"), Type.Literal("writer")]),
        systemPromptSha256: Type.String({ pattern: HASH }),
        executionLimits: Type.Optional(ExecutionLimitsSchema),
        modelReference: Type.Optional(ModelReferenceSchema),
      },
      { additionalProperties: false },
    ),
  ),
  eventSchema(
    "agent_usage",
    Type.Object(
      {
        input: SafeInteger,
        output: SafeInteger,
        cacheRead: SafeInteger,
        cacheWrite: SafeInteger,
        total: SafeInteger,
        reportedCostNanoUsd: Type.Optional(SafeInteger),
        referenceEstimateNanoUsd: Type.Optional(SafeInteger),
      },
      { additionalProperties: false },
    ),
  ),
  eventSchema(
    "tool_started",
    Type.Object(
      {
        toolName: Type.String({ minLength: 1, maxLength: 100 }),
        toolCallId: Type.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
  ),
  eventSchema(
    "tool_finished",
    Type.Object(
      {
        toolName: Type.String({ minLength: 1, maxLength: 100 }),
        toolCallId: Type.String({ minLength: 1, maxLength: 200 }),
        isError: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  ),
  eventSchema(
    "gate_finished",
    Type.Object(
      {
        passed: Type.Boolean(),
        commandCount: Type.Integer({ minimum: 0 }),
        changedPathCount: Type.Integer({ minimum: 0 }),
        timedOut: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  ),
  eventSchema(
    "review_finished",
    Type.Object(
      {
        verdict: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL")]),
        blockerCount: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  ),
  eventSchema("heartbeat", empty()),
  eventSchema(
    "artifact_available",
    Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 255 }),
        size: Type.Integer({ minimum: 0 }),
        sha256: Type.Optional(Type.String({ pattern: HASH })),
      },
      { additionalProperties: false },
    ),
  ),
  eventSchema(
    "publication_completed",
    Type.Object(
      {
        number: Type.Integer({ minimum: 1 }),
        url: Type.String({
          pattern: "^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*$",
          maxLength: 500,
        }),
        branch: Type.String({
          pattern: "^factory/[a-z0-9][a-z0-9-]*-[0-9a-f]{12}$",
          maxLength: 255,
        }),
        commitSha: Type.String({ pattern: COMMIT_SHA }),
      },
      { additionalProperties: false },
    ),
  ),
  eventSchema(
    "decision_requested",
    Type.Object(
      {
        count: Type.Integer({ minimum: 1, maximum: 10 }),
        commentId: Type.String({ minLength: 1, maxLength: 100 }),
        commentUrl: Type.String({ pattern: "^https://linear\\.app/", maxLength: 500 }),
        continuationRunId: Type.String({ pattern: RUN_ID }),
      },
      { additionalProperties: false },
    ),
  ),
  eventSchema(
    "failure",
    Type.Object(
      {
        stage: Type.String({ minLength: 1, maxLength: 100 }),
        message: Type.String({ minLength: 1, maxLength: 1000 }),
      },
      { additionalProperties: false },
    ),
  ),
  eventSchema(
    "cleanup_updated",
    Type.Object(
      {
        cleanup: Type.Union([
          Type.Literal("pending"),
          Type.Literal("complete"),
          Type.Literal("not-needed"),
          Type.Literal("failed"),
        ]),
      },
      { additionalProperties: false },
    ),
  ),
  eventSchema(
    "run_finished",
    Type.Object(
      {
        status: Type.Union([
          Type.Literal("awaiting_decision"),
          Type.Literal("ready_for_publication"),
          Type.Literal("completed"),
          Type.Literal("failed"),
        ]),
        cleanup: Type.Union([
          Type.Literal("pending"),
          Type.Literal("complete"),
          Type.Literal("not-needed"),
          Type.Literal("failed"),
        ]),
      },
      { additionalProperties: false },
    ),
  ),
]);

export type TelemetryActor = Static<typeof ActorSchema>;
export type TelemetryPhaseName = Static<typeof PhaseNameSchema>;
export type TelemetryRecord = Static<typeof TelemetryRecordSchema>;
export type TelemetryEventType = TelemetryRecord["type"];
type WithoutStoredFields<Record> = Record extends TelemetryRecord
  ? Omit<Record, "version" | "runId" | "seq" | "eventId" | "recordedAt">
  : never;
export type TelemetryInput = WithoutStoredFields<TelemetryRecord>;

function errors(value: unknown): string {
  return Value.Errors(TelemetryRecordSchema, value)
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("; ");
}

export function parseTelemetryRecord(value: unknown): TelemetryRecord {
  if (!Value.Check(TelemetryRecordSchema, value))
    throw new Error(`invalid telemetry: ${errors(value)}`);
  const record = value;
  if (record.eventId !== `${record.runId}:${record.seq}`)
    throw new Error("invalid telemetry eventId");
  if (!Number.isFinite(Date.parse(record.recordedAt)))
    throw new Error("invalid telemetry recordedAt");
  if (record.sourceAt && !Number.isFinite(Date.parse(record.sourceAt)))
    throw new Error("invalid telemetry sourceAt");
  if (record.type === "agent_context" && record.payload.modelReference) {
    for (const dateValue of [
      record.payload.modelReference.knowledgeCutoff,
      record.payload.modelReference.releaseDate,
      record.payload.modelReference.updatedAt,
    ]) {
      const date = new Date(`${dateValue}T00:00:00.000Z`);
      if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== dateValue)
        throw new Error("invalid telemetry model reference date");
    }
  }
  if (
    [
      "phase_started",
      "phase_finished",
      "agent_started",
      "agent_finished",
      "agent_context",
      "agent_usage",
      "tool_started",
      "tool_finished",
      "gate_finished",
      "review_finished",
    ].includes(record.type) &&
    !record.phase
  )
    throw new Error("phase-bound telemetry requires phase");
  if (record.type === "artifact_available") {
    const name = record.payload.name;
    if (
      typeof name !== "string" ||
      name === "." ||
      name === ".." ||
      name.includes("\0") ||
      name.includes("/") ||
      name.includes("\\") ||
      basename(name) !== name
    )
      throw new Error("invalid telemetry artifact name");
  }
  if (
    record.type === "agent_usage" &&
    BigInt(record.payload.total) !==
      BigInt(record.payload.input) +
        BigInt(record.payload.output) +
        BigInt(record.payload.cacheRead) +
        BigInt(record.payload.cacheWrite)
  )
    throw new Error("invalid telemetry token total");
  if (
    record.type === "run_finished" &&
    (record.payload.status === "awaiting_decision" ||
      record.payload.status === "ready_for_publication" ||
      record.payload.status === "completed") &&
    !["complete", "not-needed"].includes(record.payload.cleanup)
  )
    throw new Error("successful telemetry requires cleanup");
  return record;
}

export function telemetryPath(root: string, runId: string): string {
  if (!new RegExp(RUN_ID).test(runId)) throw new Error("invalid telemetry runId");
  return resolve(root, ".factory", "telemetry", `${runId}.jsonl`);
}

export function readTelemetry(path: string): TelemetryRecord[] {
  if (!existsSync(path)) return [];
  if (statSync(path).size > MAX_TELEMETRY_FILE_BYTES)
    throw new Error("telemetry file exceeds limit");
  const content = readFileSync(path);
  if (content.length > MAX_TELEMETRY_FILE_BYTES) throw new Error("telemetry file exceeds limit");
  const end =
    content.length > 0 && content.at(-1) === 0x0a ? content.length : content.lastIndexOf(0x0a) + 1;
  const complete = content.subarray(0, end).toString("utf8");
  if (!complete) return [];
  const records = complete
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      if (Buffer.byteLength(line) > MAX_TELEMETRY_LINE_BYTES)
        throw new Error("telemetry line exceeds limit");
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error("invalid telemetry JSON");
      }
      return parseTelemetryRecord(value);
    });
  let terminal: Extract<TelemetryRecord, { type: "run_finished" }> | undefined;
  let reconciled = false;
  const contexts = new Set<string>();
  const referenceContexts = new Map<
    string,
    Extract<TelemetryRecord, { type: "agent_context" }>["payload"]["modelReference"]
  >();
  const usages = new Set<string>();
  const agentStates = new Map<string, "started" | "completed" | "failed" | "timed_out">();
  const activeTools = new Map<string, { phaseId: string; name: string }>();
  const seenPhases = new Set<string>();
  const openPhases = new Map<
    string,
    { phase: NonNullable<TelemetryRecord["phase"]>; actor: TelemetryActor }
  >();
  for (const [index, record] of records.entries()) {
    if (record.seq !== index + 1) throw new Error("telemetry sequence is not gap-free");
    if (index > 0 && record.runId !== records[0]?.runId) throw new Error("mixed telemetry runId");
    if (terminal) {
      if (
        reconciled ||
        record.type !== "cleanup_updated" ||
        terminal.payload.status !== "failed" ||
        !["failed", "pending"].includes(terminal.payload.cleanup) ||
        record.payload.cleanup !== "complete"
      )
        throw new Error("invalid telemetry after terminal event");
      reconciled = true;
    }
    if (record.type === "phase_started" && record.phase) {
      if (seenPhases.has(record.phase.id)) throw new Error("duplicate phase start");
      seenPhases.add(record.phase.id);
      const expected: Partial<Record<TelemetryActor, string>> = {
        planner: "planning",
        worker: "implementing",
        reviewer: "reviewing",
      };
      const expectedName = expected[record.actor];
      if (expectedName && record.phase.name !== expectedName)
        throw new Error("invalid agent phase identity");
      openPhases.set(record.phase.id, { phase: record.phase, actor: record.actor });
    }
    if (
      record.phase &&
      ["agent_started", "agent_finished", "tool_started", "tool_finished"].includes(record.type)
    ) {
      const started = openPhases.get(record.phase.id);
      if (
        !started ||
        started.actor !== record.actor ||
        started.phase.name !== record.phase.name ||
        started.phase.attempt !== record.phase.attempt
      )
        throw new Error("agent activity outside matching phase");
      if (usages.has(record.phase.id)) throw new Error("agent activity after usage");
    }
    if (record.type === "agent_started" && record.phase) {
      if (agentStates.has(record.phase.id)) throw new Error("duplicate agent start");
      agentStates.set(record.phase.id, "started");
    }
    if (record.type === "agent_finished" && record.phase) {
      if (agentStates.get(record.phase.id) !== "started")
        throw new Error("agent finish without matching start");
      agentStates.set(record.phase.id, record.payload.status);
    }
    if (record.type === "tool_started" && record.phase) {
      if (activeTools.has(record.payload.toolCallId)) throw new Error("duplicate active tool");
      activeTools.set(record.payload.toolCallId, {
        phaseId: record.phase.id,
        name: record.payload.toolName,
      });
    }
    if (record.type === "tool_finished" && record.phase) {
      const tool = activeTools.get(record.payload.toolCallId);
      if (!tool || tool.phaseId !== record.phase.id || tool.name !== record.payload.toolName)
        throw new Error("tool finish without matching start");
      activeTools.delete(record.payload.toolCallId);
    }
    if (record.type === "agent_context" || record.type === "agent_usage") {
      if (!record.phase || !["planner", "worker", "documenter", "reviewer"].includes(record.actor))
        throw new Error("agent telemetry requires agent phase");
      const started = openPhases.get(record.phase.id);
      if (
        !started ||
        started.actor !== record.actor ||
        started.phase.name !== record.phase.name ||
        started.phase.attempt !== record.phase.attempt
      )
        throw new Error("agent telemetry outside active phase");
      if (record.type === "agent_context") {
        if (contexts.has(record.phase.id)) throw new Error("duplicate agent context");
        contexts.add(record.phase.id);
        referenceContexts.set(record.phase.id, record.payload.modelReference);
      } else {
        if (!contexts.has(record.phase.id)) throw new Error("agent usage before context");
        if (record.payload.referenceEstimateNanoUsd !== undefined) {
          const reference = referenceContexts.get(record.phase.id);
          const expected = reference && estimateReferenceNanoUsd(record.payload, reference);
          if (expected === undefined || expected !== record.payload.referenceEstimateNanoUsd)
            throw new Error("invalid telemetry reference estimate");
        }
        if (
          agentStates.get(record.phase.id) !== "completed" ||
          [...activeTools.values()].some((tool) => tool.phaseId === record.phase!.id)
        )
          throw new Error("agent usage before completed activity");
        if (usages.has(record.phase.id)) throw new Error("duplicate agent usage");
        usages.add(record.phase.id);
      }
    }
    if (record.type === "phase_finished" && record.phase) {
      const started = openPhases.get(record.phase.id);
      if (
        !started ||
        started.actor !== record.actor ||
        started.phase.name !== record.phase.name ||
        started.phase.attempt !== record.phase.attempt
      )
        throw new Error("phase closure does not match active phase");
      if (
        record.payload.status === "completed" &&
        ([...activeTools.values()].some((tool) => tool.phaseId === record.phase!.id) ||
          (["planner", "worker", "documenter", "reviewer"].includes(record.actor) &&
            (agentStates.get(record.phase.id) !== "completed" || !usages.has(record.phase.id))))
      )
        throw new Error("completed phase has incomplete agent activity");
      openPhases.delete(record.phase.id);
    }
    if (record.type === "run_finished") terminal = record;
  }
  return records;
}

export interface TelemetryWriter {
  readonly path: string;
  append(input: TelemetryInput): TelemetryRecord;
}

export function createTelemetryWriter(root: string, runId: string): TelemetryWriter {
  const path = telemetryPath(root, runId);
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  chmodSync(resolve(path, ".."), 0o700);
  if (!existsSync(path)) {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  if (statSync(path).size > MAX_TELEMETRY_FILE_BYTES)
    throw new Error("telemetry file exceeds limit");
  const content = readFileSync(path);
  if (content.length > MAX_TELEMETRY_FILE_BYTES) throw new Error("telemetry file exceeds limit");
  if (content.length > 0 && content.at(-1) !== 0x0a)
    truncateSync(path, content.lastIndexOf(0x0a) + 1);
  const previous = readTelemetry(path);
  let terminal = previous.find((record) => record.type === "run_finished");
  let reconciled = terminal ? previous.at(-1)?.type === "cleanup_updated" : false;
  let next = previous.length + 1;
  return {
    path,
    append(input) {
      if (terminal) {
        if (
          reconciled ||
          input.type !== "cleanup_updated" ||
          terminal.payload.status !== "failed" ||
          !["failed", "pending"].includes(terminal.payload.cleanup) ||
          input.payload.cleanup !== "complete"
        )
          throw new Error("telemetry is already terminal");
      }
      const record = parseTelemetryRecord({
        ...input,
        version: 1,
        runId,
        seq: next,
        eventId: `${runId}:${next}`,
        recordedAt: new Date().toISOString(),
      });
      const phaseId = record.phase?.id;
      const phaseEvents = previous.filter((event) => event.phase?.id === phaseId);
      if (record.type === "phase_started" && phaseEvents.length)
        throw new Error("duplicate phase start");
      if (record.type === "phase_finished" && record.phase) {
        const started = phaseEvents.findLast((event) => event.type === "phase_started");
        const finished = phaseEvents.findLast((event) => event.type === "phase_finished");
        if (
          !started ||
          finished ||
          started.actor !== record.actor ||
          started.phase?.name !== record.phase.name ||
          started.phase?.attempt !== record.phase.attempt
        )
          throw new Error("phase closure does not match active phase");
        if (
          record.payload.status === "completed" &&
          ["planner", "worker", "documenter", "reviewer"].includes(record.actor) &&
          (!phaseEvents.some(
            (event) => event.type === "agent_finished" && event.payload.status === "completed",
          ) ||
            !phaseEvents.some((event) => event.type === "agent_usage"))
        )
          throw new Error("completed phase has incomplete agent activity");
      }
      if (
        record.phase &&
        ["agent_started", "agent_finished", "tool_started", "tool_finished"].includes(record.type)
      ) {
        const started = phaseEvents.findLast((event) => event.type === "phase_started");
        if (
          !started ||
          started.actor !== record.actor ||
          started.phase?.name !== record.phase.name ||
          started.phase?.attempt !== record.phase.attempt
        )
          throw new Error("agent activity outside matching phase");
        if (phaseEvents.some((event) => event.type === "agent_usage"))
          throw new Error("agent activity after usage");
        if (
          record.type === "agent_started" &&
          phaseEvents.some((event) => event.type === "agent_started")
        )
          throw new Error("duplicate agent start");
        if (
          record.type === "agent_finished" &&
          (phaseEvents.filter((event) => event.type === "agent_started").length !== 1 ||
            phaseEvents.some((event) => event.type === "agent_finished"))
        )
          throw new Error("agent finish without matching start");
        if (record.type === "tool_started") {
          const open = previous.findLast(
            (event) =>
              (event.type === "tool_started" || event.type === "tool_finished") &&
              event.payload.toolCallId === record.payload.toolCallId,
          );
          if (open?.type === "tool_started") throw new Error("duplicate active tool");
        }
        if (record.type === "tool_finished") {
          const open = previous.findLast(
            (event) =>
              (event.type === "tool_started" || event.type === "tool_finished") &&
              event.payload.toolCallId === record.payload.toolCallId,
          );
          if (
            open?.type !== "tool_started" ||
            open.phase?.id !== record.phase.id ||
            open.payload.toolName !== record.payload.toolName
          )
            throw new Error("tool finish without matching start");
        }
      }
      if (record.type === "agent_context" || record.type === "agent_usage") {
        const started = phaseEvents.findLast((event) => event.type === "phase_started");
        const finished = phaseEvents.findLast((event) => event.type === "phase_finished");
        if (
          !phaseId ||
          !started ||
          finished ||
          started.actor !== record.actor ||
          started.phase?.name !== record.phase?.name ||
          started.phase?.attempt !== record.phase?.attempt
        )
          throw new Error("agent telemetry outside active phase");
        if (
          record.type === "agent_context" &&
          phaseEvents.some((event) => event.type === "agent_context")
        )
          throw new Error("duplicate agent context");
        if (record.type === "agent_usage") {
          const context = phaseEvents.find((event) => event.type === "agent_context");
          if (!context || context.type !== "agent_context")
            throw new Error("agent usage before context");
          if (record.payload.referenceEstimateNanoUsd !== undefined) {
            const reference = context.payload.modelReference;
            const expected = reference && estimateReferenceNanoUsd(record.payload, reference);
            if (expected === undefined || expected !== record.payload.referenceEstimateNanoUsd)
              throw new Error("invalid telemetry reference estimate");
          }
          if (
            !phaseEvents.some(
              (event) =>
                event.type === "agent_finished" &&
                event.actor === record.actor &&
                event.phase?.name === record.phase?.name &&
                event.phase?.attempt === record.phase?.attempt,
            ) ||
            phaseEvents.some(
              (event) =>
                event.type === "tool_started" &&
                !phaseEvents.some(
                  (end) =>
                    end.type === "tool_finished" &&
                    end.payload.toolCallId === event.payload.toolCallId,
                ),
            )
          )
            throw new Error("agent usage before completed activity");
          if (phaseEvents.some((event) => event.type === "agent_usage"))
            throw new Error("duplicate agent usage");
        }
      }
      const line = `${JSON.stringify(record)}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (lineBytes > MAX_TELEMETRY_LINE_BYTES) throw new Error("telemetry line exceeds limit");
      if (statSync(path).size + lineBytes > MAX_TELEMETRY_FILE_BYTES)
        throw new Error("telemetry file exceeds limit");
      appendFileSync(path, line, { encoding: "utf8", mode: 0o600, flush: true });
      previous.push(record);
      next += 1;
      if (terminal) reconciled = true;
      if (record.type === "run_finished") terminal = record;
      return record;
    },
  };
}

export function sanitizeTelemetryText(value: string, secrets: string[]): string {
  const redacted = secrets
    .filter(Boolean)
    .toSorted((left, right) => right.length - left.length)
    .reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
  return (
    redacted
      .replaceAll(/\p{Cc}/gu, " ")
      .slice(0, 1000)
      .trim() || "unknown failure"
  );
}
