import { StringDecoder } from "node:string_decoder";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ALLOWED_AGENT_TOOLS } from "./agents/index.js";
import { WORKFLOW_STEP_IDS, workflowStep, type WorkflowStepId } from "./workflow-step.js";

export const MAX_REMOTE_FRAME_BYTES = 64 * 1024;
export const MAX_REMOTE_FRAMES = 20_000;
export const MAX_REMOTE_STREAM_BYTES = 8 * 1024 * 1024;

const ActorSchema = Type.Union([
  Type.Literal("planner"),
  Type.Literal("worker"),
  Type.Literal("documenter"),
  Type.Literal("verifier"),
  Type.Literal("reviewer"),
]);
const PhaseSchema = Type.Union([
  Type.Literal("planning"),
  Type.Literal("implementing"),
  Type.Literal("documenting"),
  Type.Literal("verifying"),
  Type.Literal("reviewing"),
]);
const StatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("timed_out"),
]);
const FailureCodeSchema = Type.Union([
  Type.Literal("model_request_failed"),
  Type.Literal("envelope_invalid"),
  Type.Literal("ownership_failed"),
  Type.Literal("verification_failed"),
  Type.Literal("review_failed"),
  Type.Literal("timed_out"),
  Type.Literal("agent_failed"),
]);
const RemoteFailureSchema = Type.Object(
  { phase: PhaseSchema, code: FailureCodeSchema },
  { additionalProperties: false },
);
const TokenSchema = Type.Object(
  {
    input: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    output: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    cacheRead: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    cacheWrite: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    total: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export const REMOTE_TOOL_NAMES = [...ALLOWED_AGENT_TOOLS, "submit_envelope"] as const;
export const ToolNameSchema = Type.String({ enum: REMOTE_TOOL_NAMES });
const WorkflowStepIdSchema = Type.Unsafe<WorkflowStepId>({
  type: "string",
  enum: WORKFLOW_STEP_IDS,
});

const RemoteEventSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("phase_started"),
      actor: ActorSchema,
      phase: PhaseSchema,
      stepId: WorkflowStepIdSchema,
      sourceAt: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("phase_finished"),
      actor: ActorSchema,
      phase: PhaseSchema,
      stepId: WorkflowStepIdSchema,
      status: StatusSchema,
      sourceAt: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("agent_started"),
      actor: ActorSchema,
      phase: PhaseSchema,
      stepId: WorkflowStepIdSchema,
      sourceAt: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("agent_finished"),
      actor: ActorSchema,
      phase: PhaseSchema,
      stepId: WorkflowStepIdSchema,
      status: StatusSchema,
      sourceAt: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("agent_content"),
      actor: ActorSchema,
      phase: PhaseSchema,
      stepId: WorkflowStepIdSchema,
      contentId: Type.String({ minLength: 1, maxLength: 200 }),
      kind: Type.Union([
        Type.Literal("user_prompt"),
        Type.Literal("assistant_message"),
        Type.Literal("reasoning"),
      ]),
      chunkIndex: Type.Integer({ minimum: 0 }),
      chunkCount: Type.Integer({ minimum: 1, maximum: 32 }),
      text: Type.String({ maxLength: 8192 }),
      sourceAt: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("agent_content_unavailable"),
      actor: ActorSchema,
      phase: PhaseSchema,
      stepId: WorkflowStepIdSchema,
      contentId: Type.String({ minLength: 1, maxLength: 200 }),
      kind: Type.Union([
        Type.Literal("user_prompt"),
        Type.Literal("assistant_message"),
        Type.Literal("reasoning"),
      ]),
      reason: Type.Union([
        Type.Literal("item_too_large"),
        Type.Literal("phase_budget_exhausted"),
        Type.Literal("provider_redacted"),
      ]),
      sourceAt: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("tool_started"),
      actor: ActorSchema,
      phase: PhaseSchema,
      stepId: WorkflowStepIdSchema,
      toolName: ToolNameSchema,
      toolCallId: Type.String({ minLength: 1, maxLength: 200 }),
      sourceAt: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("tool_finished"),
      actor: ActorSchema,
      phase: PhaseSchema,
      stepId: WorkflowStepIdSchema,
      toolName: ToolNameSchema,
      toolCallId: Type.String({ minLength: 1, maxLength: 200 }),
      isError: Type.Boolean(),
      sourceAt: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("agent_usage"),
      actor: Type.Union([
        Type.Literal("planner"),
        Type.Literal("worker"),
        Type.Literal("documenter"),
        Type.Literal("reviewer"),
      ]),
      phase: Type.Union([
        Type.Literal("planning"),
        Type.Literal("implementing"),
        Type.Literal("documenting"),
        Type.Literal("reviewing"),
      ]),
      stepId: WorkflowStepIdSchema,
      tokens: TokenSchema,
      contextTokens: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
      contextWindow: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
      reportedCostNanoUsd: Type.Optional(
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      ),
      sourceAt: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("gate_finished"),
      actor: Type.Literal("verifier"),
      phase: Type.Literal("verifying"),
      stepId: Type.Literal("verify"),
      passed: Type.Boolean(),
      commandCount: Type.Integer({ minimum: 0 }),
      changedPathCount: Type.Integer({ minimum: 0 }),
      timedOut: Type.Boolean(),
      sourceAt: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("review_finished"),
      actor: Type.Literal("reviewer"),
      phase: Type.Literal("reviewing"),
      stepId: Type.Literal("review"),
      verdict: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL")]),
      blockerCount: Type.Integer({ minimum: 0 }),
      sourceAt: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

const EventFrameSchema = Type.Object(
  {
    protocol: Type.Literal(2),
    kind: Type.Literal("event"),
    remoteSeq: Type.Integer({ minimum: 1 }),
    event: RemoteEventSchema,
  },
  { additionalProperties: false },
);
const ResultFrameSchema = Type.Object(
  {
    protocol: Type.Literal(2),
    kind: Type.Literal("result"),
    remoteSeq: Type.Integer({ minimum: 1 }),
    status: StatusSchema,
    runDir: Type.String({ minLength: 1 }),
    reviewerRunDir: Type.Optional(Type.String({ minLength: 1 })),
    failure: Type.Optional(RemoteFailureSchema),
  },
  { additionalProperties: false },
);
export const RemoteFrameSchema = Type.Union([EventFrameSchema, ResultFrameSchema]);
export type RemoteToolName = (typeof REMOTE_TOOL_NAMES)[number];
export type RemoteEvent = Static<typeof RemoteEventSchema>;
export type RemoteFrame = Static<typeof RemoteFrameSchema>;
export type RemoteResultFrame = Static<typeof ResultFrameSchema>;
export type RemoteFailure = Static<typeof RemoteFailureSchema>;
export type RemoteEventSink = (event: RemoteEvent) => void;

export function isRemoteToolName(value: string): value is RemoteToolName {
  return Value.Check(ToolNameSchema, value);
}

function parseFrame(line: string): RemoteFrame {
  if (Buffer.byteLength(line) > MAX_REMOTE_FRAME_BYTES)
    throw new Error("remote protocol frame exceeds limit");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("invalid remote protocol JSON");
  }
  if (!Value.Check(RemoteFrameSchema, value)) throw new Error("invalid remote protocol frame");
  const frame = value;
  if ("event" in frame) {
    const expected = workflowStep(frame.event.stepId);
    if (frame.event.phase !== expected.phase || frame.event.actor !== expected.actor)
      throw new Error("invalid remote protocol step identity");
  }
  if ("event" in frame && !Number.isFinite(Date.parse(frame.event.sourceAt)))
    throw new Error("invalid remote protocol timestamp");
  if (
    "event" in frame &&
    frame.event.type === "agent_content" &&
    (frame.event.chunkIndex >= frame.event.chunkCount ||
      Buffer.byteLength(frame.event.text) > 8 * 1024)
  )
    throw new Error("invalid remote protocol content chunk");
  if ("event" in frame && frame.event.type === "agent_usage") {
    if (
      BigInt(frame.event.tokens.total) !==
      BigInt(frame.event.tokens.input) +
        BigInt(frame.event.tokens.output) +
        BigInt(frame.event.tokens.cacheRead) +
        BigInt(frame.event.tokens.cacheWrite)
    )
      throw new Error("invalid remote protocol token total");
    if ((frame.event.contextTokens === undefined) !== (frame.event.contextWindow === undefined))
      throw new Error("invalid remote protocol context usage");
  }
  return frame;
}

export class RemoteProtocolParser {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private nextSeq = 1;
  private totalBytes = 0;
  private terminal: RemoteResultFrame | undefined;

  constructor(
    private readonly onEvent: RemoteEventSink,
    private readonly limits = {
      maxFrames: MAX_REMOTE_FRAMES,
      maxBytes: MAX_REMOTE_STREAM_BYTES,
    },
  ) {}

  private consume(text: string): void {
    this.buffer += text;
    if (Buffer.byteLength(this.buffer) > MAX_REMOTE_FRAME_BYTES && !this.buffer.includes("\n"))
      throw new Error("remote protocol frame exceeds limit");
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const frame = parseFrame(line);
      if (this.nextSeq > this.limits.maxFrames)
        throw new Error("remote protocol frame count exceeds limit");
      if (frame.remoteSeq !== this.nextSeq)
        throw new Error("remote protocol sequence is not gap-free");
      this.nextSeq += 1;
      if (frame.kind === "result") this.terminal = frame;
      else this.onEvent(frame.event);
      if (this.terminal && this.buffer.length)
        throw new Error("remote protocol data after terminal result");
    }
  }

  push(chunk: string | Buffer): void {
    if (this.terminal) throw new Error("remote protocol data after terminal result");
    this.totalBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    if (this.totalBytes > this.limits.maxBytes)
      throw new Error("remote protocol stream exceeds limit");
    this.consume(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
  }

  finish(): RemoteResultFrame {
    this.consume(this.decoder.end());
    if (this.buffer.length) throw new Error("incomplete remote protocol frame");
    if (!this.terminal) throw new Error("remote protocol terminal result missing");
    return this.terminal;
  }
}

export interface RemoteProtocolWriter {
  event(event: RemoteEvent): void;
  result(value: Omit<RemoteResultFrame, "protocol" | "kind" | "remoteSeq">): void;
}

export function createRemoteProtocolWriter(write: (line: string) => void): RemoteProtocolWriter {
  let seq = 1;
  let totalBytes = 0;
  let terminal = false;
  const emit = (frame: RemoteFrame) => {
    if (terminal) throw new Error("remote protocol already terminal");
    if (seq > MAX_REMOTE_FRAMES) throw new Error("remote protocol frame count exceeds limit");
    const line = `${JSON.stringify(frame)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > MAX_REMOTE_FRAME_BYTES) throw new Error("remote protocol frame exceeds limit");
    totalBytes += lineBytes;
    if (totalBytes > MAX_REMOTE_STREAM_BYTES)
      throw new Error("remote protocol stream exceeds limit");
    write(line);
    if (frame.kind === "result") terminal = true;
    seq += 1;
  };
  return {
    event(event) {
      emit({ protocol: 2, kind: "event", remoteSeq: seq, event });
    },
    result(value) {
      emit({ protocol: 2, kind: "result", remoteSeq: seq, ...value });
    },
  };
}
