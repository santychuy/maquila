import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export type EnvelopeRole = "planner" | "worker" | "reviewer";

const PlannerChangeSchema = Type.Object(
  {
    path: Type.String({ description: "Repository-relative file path" }),
    action: Type.String({ description: "Change kind, for example add, modify, or delete" }),
    rationale: Type.String({ description: "Why this change is needed" }),
  },
  { additionalProperties: false },
);

export const PlannerEnvelopeSchema = Type.Object(
  {
    summary: Type.String({ description: "One-paragraph summary of the plan" }),
    evidence: Type.Array(Type.String(), { description: "Observed issue or repository facts backing the plan" }),
    changes: Type.Array(PlannerChangeSchema, { description: "Planned file changes" }),
    verification: Type.Array(Type.String(), { description: "Commands or checks that verify the implementation" }),
    risks: Type.Array(Type.String(), { description: "Known risks of the plan" }),
    decisionsNeeded: Type.Array(Type.String(), {
      description: "Unresolved decisions blocking planning; non-empty permits empty changes and verification",
    }),
  },
  { additionalProperties: false },
);

const WorkerValidationSchema = Type.Object(
  {
    command: Type.String({ description: "Check command that was run" }),
    outcome: Type.Unsafe<"pass" | "fail" | "skipped">({
      type: "string",
      enum: ["pass", "fail", "skipped"],
      description: "Check outcome",
    }),
    detail: Type.String({ description: "Short result detail" }),
  },
  { additionalProperties: false },
);

export const WorkerEnvelopeSchema = Type.Object(
  {
    implemented: Type.String({ description: "What was implemented" }),
    changedFiles: Type.Array(Type.String(), { description: "Files actually changed" }),
    validation: Type.Array(WorkerValidationSchema, { description: "Checks run with honest outcomes" }),
    openRisks: Type.Array(Type.String(), { description: "Remaining risks or follow-ups" }),
  },
  { additionalProperties: false },
);

export const ReviewerEnvelopeSchema = Type.Object(
  {
    verdict: Type.Unsafe<"PASS" | "FAIL">({ type: "string", enum: ["PASS", "FAIL"], description: "Review verdict" }),
    correct: Type.Array(Type.String(), { description: "What the implementation gets right" }),
    blockingFindings: Type.Array(Type.String(), { description: "Defects that must be fixed; empty iff verdict is PASS" }),
    nonBlockingFindings: Type.Array(Type.String(), { description: "Optional improvements" }),
    residualRisks: Type.Array(Type.String(), { description: "Risks remaining after review" }),
  },
  { additionalProperties: false },
);

const Schemas: Record<EnvelopeRole, TSchema> = {
  planner: PlannerEnvelopeSchema,
  worker: WorkerEnvelopeSchema,
  reviewer: ReviewerEnvelopeSchema,
};

export type PlannerEnvelope = Static<typeof PlannerEnvelopeSchema>;
export type WorkerEnvelope = Static<typeof WorkerEnvelopeSchema>;
export type ReviewerEnvelope = Static<typeof ReviewerEnvelopeSchema>;
export type Envelope = PlannerEnvelope | WorkerEnvelope | ReviewerEnvelope;

export type EnvelopeParseResult<T extends Envelope = Envelope> =
  | { ok: true; envelope: T }
  | { ok: false; errors: string[] };

function structuralErrors(schema: TSchema, value: unknown): string[] {
  return Value.Errors(schema, value).map((error) => `${error.instancePath || "/"}: ${error.message}`);
}

function trimStrings(value: unknown, path: string, errors: string[]): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) errors.push(`${path || "/"}: must not be empty`);
    return trimmed;
  }
  if (Array.isArray(value)) return value.map((item, index) => trimStrings(item, `${path}/${index}`, errors));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trimStrings(item, `${path}/${key}`, errors)]));
  }
  return value;
}

function semanticErrors(role: EnvelopeRole, envelope: Envelope): string[] {
  const errors: string[] = [];
  if (role === "planner" && "changes" in envelope) {
    if (envelope.decisionsNeeded.length === 0) {
      if (envelope.changes.length === 0) {
        errors.push("/changes: at least one change is required when decisionsNeeded is empty");
      }
      if (envelope.verification.length === 0) {
        errors.push("/verification: at least one verification step is required when decisionsNeeded is empty");
      }
    }
  }
  if (role === "reviewer" && "verdict" in envelope) {
    if (envelope.verdict === "PASS" && envelope.blockingFindings.length > 0) {
      errors.push("/blockingFindings: must be empty when verdict is PASS");
    }
    if (envelope.verdict === "FAIL" && envelope.blockingFindings.length === 0) {
      errors.push("/blockingFindings: at least one blocking finding is required when verdict is FAIL");
    }
  }
  return errors;
}

export function parseEnvelope(role: "planner", value: unknown): EnvelopeParseResult<PlannerEnvelope>;
export function parseEnvelope(role: "worker", value: unknown): EnvelopeParseResult<WorkerEnvelope>;
export function parseEnvelope(role: "reviewer", value: unknown): EnvelopeParseResult<ReviewerEnvelope>;
export function parseEnvelope(role: EnvelopeRole, value: unknown): EnvelopeParseResult;
export function parseEnvelope(role: EnvelopeRole, value: unknown): EnvelopeParseResult {
  const schema = Schemas[role];
  if (!Value.Check(schema, value)) return { ok: false, errors: structuralErrors(schema, value) };
  const trimErrors: string[] = [];
  const envelope = trimStrings(value, "", trimErrors) as Envelope;
  const errors = [...trimErrors, ...semanticErrors(role, envelope)];
  return errors.length ? { ok: false, errors } : { ok: true, envelope };
}

export function envelopeCorrectionPrompt(role: EnvelopeRole, errors: string[]): string {
  return [
    `Your final envelope was missing or invalid. This run requires exactly one valid ${role} envelope submitted with the submit_envelope tool as your final action.`,
    "Validation errors:",
    ...errors.map((error) => `- ${error}`),
    "Call submit_envelope exactly once with a corrected envelope. Do not call any other tool.",
  ].join("\n");
}

function renderList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

export function renderPlannerPlan(envelope: PlannerEnvelope): string {
  return [
    "## Summary",
    envelope.summary,
    "## Evidence",
    renderList(envelope.evidence),
    "## Changes",
    envelope.changes.length
      ? envelope.changes.map((change) => `- \`${change.path}\` (${change.action}): ${change.rationale}`).join("\n")
      : "- None",
    "## Verification",
    renderList(envelope.verification),
    "## Risks",
    renderList(envelope.risks),
    "## Decisions Needed",
    renderList(envelope.decisionsNeeded),
  ].join("\n\n");
}

export interface EnvelopeCapture {
  value?: unknown;
  calls: number;
}

export function createSubmitEnvelopeTool(role: EnvelopeRole, capture: EnvelopeCapture): ToolDefinition {
  return defineTool({
    name: "submit_envelope",
    label: "Submit envelope",
    description: `Submit the final ${role} envelope as structured data. This must be your final action and ends the run.`,
    promptSnippet: `submit_envelope: submit the final ${role} envelope (ends the run)`,
    parameters: Schemas[role],
    async execute(_toolCallId, params) {
      capture.value = params;
      capture.calls += 1;
      return {
        content: [{ type: "text", text: `${role} envelope received.` }],
        details: { role },
        terminate: true,
      };
    },
  });
}
