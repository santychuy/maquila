import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { type FeaturePrBlock } from "./feature-pr.js";
import { type WorkflowManifest } from "./manifest.js";

export const WORKFLOW_EXECUTION_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

const SkippedImplementSchema = Type.Object(
  {
    id: Type.Literal("implement"),
    status: Type.Literal("skipped"),
    skipReason: Type.Literal("docs-only"),
  },
  { additionalProperties: false },
);
export const WorkflowExecutionSchema = Type.Object(
  {
    version: Type.Literal(WORKFLOW_EXECUTION_VERSION),
    status: Type.Literal("completed"),
    workflowManifestSha256: Type.String({ pattern: HASH.source }),
    reviewedPatchSha256: Type.String({ pattern: HASH.source }),
    steps: Type.Tuple([
      Type.Union([
        Type.Object(
          {
            id: Type.Literal("implement"),
            status: Type.Literal("completed"),
            runId: Type.String({ pattern: UUID.source }),
          },
          { additionalProperties: false },
        ),
        SkippedImplementSchema,
      ]),
      Type.Object(
        {
          id: Type.Literal("document"),
          status: Type.Literal("completed"),
          runId: Type.String({ pattern: UUID.source }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          id: Type.Literal("verify"),
          status: Type.Literal("completed"),
          runId: Type.String({ pattern: UUID.source }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          id: Type.Literal("review"),
          status: Type.Literal("completed"),
          runId: Type.String({ pattern: UUID.source }),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);
export type WorkflowExecution = Static<typeof WorkflowExecutionSchema>;

export function workflowManifestSha256(manifest: WorkflowManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export function parseWorkflowExecution(value: unknown): WorkflowExecution {
  if (!Value.Check(WorkflowExecutionSchema, value)) throw new Error("invalid workflow execution");
  return value;
}

export function completedStepRunId(execution: WorkflowExecution, id: FeaturePrBlock): string {
  const step = execution.steps.find((entry) => entry.id === id);
  if (!step) throw new Error(`workflow execution missing ${id} step`);
  if (step.status !== "completed")
    throw new Error(`workflow execution ${id} step is not completed`);
  return step.runId;
}

export function implementRunId(execution: WorkflowExecution): string | undefined {
  const step = execution.steps[0];
  return step.status === "completed" ? step.runId : undefined;
}

function expectedSteps(
  manifest: WorkflowManifest,
  runs: { implementRunId?: string; documenterRunId: string; reviewerRunId: string },
): WorkflowExecution["steps"] {
  const implementPending = manifest.steps[0]?.status === "pending";
  if (implementPending !== Boolean(runs.implementRunId))
    throw new Error("workflow execution implement run does not match manifest");
  return [
    implementPending
      ? { id: "implement", status: "completed", runId: runs.implementRunId! }
      : { id: "implement", status: "skipped", skipReason: "docs-only" },
    { id: "document", status: "completed", runId: runs.documenterRunId },
    {
      id: "verify",
      status: "completed",
      runId: runs.implementRunId ?? runs.documenterRunId,
    },
    { id: "review", status: "completed", runId: runs.reviewerRunId },
  ];
}

export function createFeaturePrExecution(input: {
  manifest: WorkflowManifest;
  implementRunId?: string;
  documenterRunId: string;
  reviewerRunId: string;
  reviewedPatchSha256: string;
}): WorkflowExecution {
  if (!HASH.test(input.reviewedPatchSha256)) throw new Error("invalid reviewed patch hash");
  const execution: WorkflowExecution = {
    version: WORKFLOW_EXECUTION_VERSION,
    status: "completed",
    workflowManifestSha256: workflowManifestSha256(input.manifest),
    reviewedPatchSha256: input.reviewedPatchSha256,
    steps: expectedSteps(input.manifest, input),
  };
  return parseWorkflowExecution(execution);
}

export function assertFeaturePrExecution(
  execution: WorkflowExecution,
  manifest: WorkflowManifest,
  reviewedPatchSha256?: string,
): void {
  parseWorkflowExecution(execution);
  if (execution.workflowManifestSha256 !== workflowManifestSha256(manifest))
    throw new Error("workflow execution manifest hash mismatch");
  const implement = implementRunId(execution);
  const created = createFeaturePrExecution({
    manifest,
    ...(implement ? { implementRunId: implement } : {}),
    documenterRunId: completedStepRunId(execution, "document"),
    reviewerRunId: completedStepRunId(execution, "review"),
    reviewedPatchSha256: execution.reviewedPatchSha256,
  });
  if (JSON.stringify(execution) !== JSON.stringify(created))
    throw new Error("workflow execution does not match manifest");
  if (reviewedPatchSha256 !== undefined && execution.reviewedPatchSha256 !== reviewedPatchSha256)
    throw new Error("workflow execution patch hash mismatch");
}

export function primaryRunId(execution: WorkflowExecution): string {
  return implementRunId(execution) ?? completedStepRunId(execution, "document");
}

export function completedExecutionRunIds(execution: WorkflowExecution): string[] {
  const ids = execution.steps.flatMap((step) => (step.status === "completed" ? [step.runId] : []));
  return [...new Set(ids)];
}
