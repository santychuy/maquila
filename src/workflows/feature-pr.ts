import type { PlannerEnvelope } from "../envelope.js";
import { assertSafeRepoPath } from "../verify.js";
import { workflowStep, type WorkflowStepDescriptor } from "../workflow-step.js";

export const FEATURE_PR_WORKFLOW_ID = "feature-pr";
export const FEATURE_PR_WORKFLOW_VERSION = 1;

// Strict manifest/execution tuple schemas mirror this order; invariant tests enforce the mirror.
export const FEATURE_PR_BLOCKS = ["implement", "document", "verify", "review"] as const;
export type FeaturePrBlock = (typeof FEATURE_PR_BLOCKS)[number];

export interface FeaturePrResolution {
  id: typeof FEATURE_PR_WORKFLOW_ID;
  version: typeof FEATURE_PR_WORKFLOW_VERSION;
  allowedPaths: string[];
  implementPaths: string[];
  documentPaths: string[];
}

export function isDocumentationPath(path: string): boolean {
  return path === "docs" || path.startsWith("docs/");
}

export function authorizedFeaturePrPaths(plan: PlannerEnvelope): string[] {
  const paths = plan.changes.map((change) => assertSafeRepoPath(change.path));
  if (new Set(paths).size !== paths.length) throw new Error("planner contains duplicate paths");
  if (paths.includes("maquila.verify.json")) {
    throw new Error("planner cannot approve maquila.verify.json");
  }
  return paths;
}

export function resolveFeaturePr(plan: PlannerEnvelope): FeaturePrResolution {
  const allowedPaths = authorizedFeaturePrPaths(plan);
  const implementPaths = allowedPaths.filter((path) => !isDocumentationPath(path));
  const documentPaths = allowedPaths.filter(isDocumentationPath);
  return {
    id: FEATURE_PR_WORKFLOW_ID,
    version: FEATURE_PR_WORKFLOW_VERSION,
    allowedPaths,
    implementPaths,
    documentPaths,
  };
}

export function featurePrRemoteStepsFromManifest(
  steps: ReadonlyArray<{ id: FeaturePrBlock; status: "pending" | "skipped" }>,
): WorkflowStepDescriptor[] {
  return steps.filter((step) => step.status !== "skipped").map((step) => workflowStep(step.id));
}
