import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { PlannerEnvelope } from "../envelope.js";
import { assertSafeRepoPath } from "../verify.js";
import {
  FEATURE_PR_BLOCKS,
  FEATURE_PR_VERIFY_CODE,
  FEATURE_PR_WORKFLOW_ID,
  FEATURE_PR_WORKFLOW_VERSION,
  isDocumentationPath,
  resolveFeaturePr,
} from "./feature-pr.js";
import { workflowStep } from "../workflow-step.js";

export const WORKFLOW_MANIFEST_VERSION = 2;
export const LOCAL_PLANNER_RUN_ID = "local";
const PLANNER_RUN_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|local)$/;
const BASE_SHA = /^[0-9a-f]{40}$/;

const CommandCodeSchema = Type.Object(
  {
    kind: Type.Literal("command"),
    commands: Type.Tuple([
      Type.Tuple([Type.Literal("bun"), Type.Literal("run"), Type.Literal("check")]),
    ]),
  },
  { additionalProperties: false },
);
const SkippedImplementSchema = Type.Object(
  {
    id: Type.Literal("implement"),
    actorKind: Type.Literal("agent"),
    status: Type.Literal("skipped"),
    skipReason: Type.Literal("docs-only"),
  },
  { additionalProperties: false },
);
export const WorkflowManifestSchema = Type.Object(
  {
    version: Type.Literal(WORKFLOW_MANIFEST_VERSION),
    workflowId: Type.Literal(FEATURE_PR_WORKFLOW_ID),
    workflowVersion: Type.Literal(FEATURE_PR_WORKFLOW_VERSION),
    definitionSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    plannerRunId: Type.String({ pattern: PLANNER_RUN_ID.source }),
    baseSha: Type.String({ pattern: BASE_SHA.source }),
    allowedPaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    steps: Type.Tuple([
      Type.Union([
        Type.Object(
          {
            id: Type.Literal("implement"),
            actorKind: Type.Literal("agent"),
            status: Type.Literal("pending"),
          },
          { additionalProperties: false },
        ),
        SkippedImplementSchema,
      ]),
      Type.Object(
        {
          id: Type.Literal("document"),
          actorKind: Type.Literal("agent"),
          status: Type.Literal("pending"),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          id: Type.Literal("verify"),
          actorKind: Type.Literal("code"),
          status: Type.Literal("pending"),
          code: CommandCodeSchema,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          id: Type.Literal("review"),
          actorKind: Type.Literal("agent"),
          status: Type.Literal("pending"),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);
export type WorkflowManifest = Static<typeof WorkflowManifestSchema>;

export function featurePrDefinition() {
  return {
    id: FEATURE_PR_WORKFLOW_ID,
    version: FEATURE_PR_WORKFLOW_VERSION,
    postPlanSteps: FEATURE_PR_BLOCKS.map(workflowStep),
    verifier: FEATURE_PR_VERIFY_CODE,
    policies: {
      documentationPathOwnership: "docs-prefix-documenter-only",
      docsOnlyImplementSkip: "skip-when-no-non-documentation-paths",
    },
  } as const;
}

export function featurePrDefinitionSha256(): string {
  return createHash("sha256").update(JSON.stringify(featurePrDefinition())).digest("hex");
}

export function plannerRunIdFromEnvelopePath(plannerEnvelope: string): string {
  const parent = basename(dirname(resolve(plannerEnvelope)));
  return PLANNER_RUN_ID.test(parent) && parent !== LOCAL_PLANNER_RUN_ID
    ? parent
    : LOCAL_PLANNER_RUN_ID;
}

function expectedSteps(implementPaths: string[]): WorkflowManifest["steps"] {
  return [
    implementPaths.length
      ? { id: "implement", actorKind: "agent", status: "pending" }
      : { id: "implement", actorKind: "agent", status: "skipped", skipReason: "docs-only" },
    { id: "document", actorKind: "agent", status: "pending" },
    {
      id: "verify",
      actorKind: "code",
      status: "pending",
      code: { kind: "command", commands: [["bun", "run", "check"]] },
    },
    { id: "review", actorKind: "agent", status: "pending" },
  ];
}

export function createFeaturePrManifest(input: {
  plannerRunId: string;
  baseSha: string;
  plan: PlannerEnvelope;
}): WorkflowManifest {
  if (!PLANNER_RUN_ID.test(input.plannerRunId)) throw new Error("invalid planner run identity");
  if (!BASE_SHA.test(input.baseSha)) throw new Error("invalid base SHA");
  const resolved = resolveFeaturePr(input.plan);
  const manifest: WorkflowManifest = {
    version: WORKFLOW_MANIFEST_VERSION,
    workflowId: FEATURE_PR_WORKFLOW_ID,
    workflowVersion: FEATURE_PR_WORKFLOW_VERSION,
    definitionSha256: featurePrDefinitionSha256(),
    plannerRunId: input.plannerRunId,
    baseSha: input.baseSha,
    allowedPaths: resolved.allowedPaths,
    steps: expectedSteps(resolved.implementPaths),
  };
  return parseWorkflowManifest(manifest);
}

export function parseWorkflowManifest(value: unknown): WorkflowManifest {
  if (!Value.Check(WorkflowManifestSchema, value)) throw new Error("invalid workflow manifest");
  const allowed = value.allowedPaths.map(assertSafeRepoPath);
  if (new Set(allowed).size !== allowed.length)
    throw new Error("workflow manifest contains duplicate paths");
  if (JSON.stringify(allowed) !== JSON.stringify(value.allowedPaths))
    throw new Error("invalid workflow manifest paths");
  if (value.definitionSha256 !== featurePrDefinitionSha256())
    throw new Error("workflow definition hash mismatch");
  const implementPaths = allowed.filter((path) => !isDocumentationPath(path));
  if (JSON.stringify(value.steps) !== JSON.stringify(expectedSteps(implementPaths)))
    throw new Error("workflow manifest steps do not match approved paths");
  return value;
}

export function assertFeaturePrManifest(
  manifest: WorkflowManifest,
  expected: { plannerRunId: string; baseSha: string; plan: PlannerEnvelope },
): void {
  const created = createFeaturePrManifest(expected);
  if (JSON.stringify(manifest) !== JSON.stringify(created))
    throw new Error("workflow manifest does not match accepted plan");
}

export function readWorkflowManifest(path: string): WorkflowManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read workflow manifest: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parseWorkflowManifest(parsed);
}
