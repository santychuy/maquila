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

export const MAX_TELEMETRY_LINE_BYTES = 64 * 1024;
export const MAX_TELEMETRY_FILE_BYTES = 32 * 1024 * 1024;
const RUN_ID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const HASH = "^[0-9a-f]{64}$";
const COMMIT_SHA = "^[0-9a-f]{40}$";

const ActorSchema = Type.Union([
  Type.Literal("controller"),
  Type.Literal("planner"),
  Type.Literal("worker"),
  Type.Literal("verifier"),
  Type.Literal("reviewer"),
]);
const PhaseNameSchema = Type.Union([
  Type.Literal("intake"),
  Type.Literal("creating_vm"),
  Type.Literal("bootstrapping"),
  Type.Literal("planning"),
  Type.Literal("implementing"),
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
    record.type === "run_finished" &&
    (record.payload.status === "ready_for_publication" || record.payload.status === "completed") &&
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
      const line = `${JSON.stringify(record)}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (lineBytes > MAX_TELEMETRY_LINE_BYTES) throw new Error("telemetry line exceeds limit");
      if (statSync(path).size + lineBytes > MAX_TELEMETRY_FILE_BYTES)
        throw new Error("telemetry file exceeds limit");
      appendFileSync(path, line, { encoding: "utf8", mode: 0o600, flush: true });
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
      .replaceAll(/[\r\n\0]/g, " ")
      .slice(0, 1000)
      .trim() || "unknown failure"
  );
}
