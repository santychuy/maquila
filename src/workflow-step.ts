export const WORKFLOW_STEP_IDS = ["plan", "implement", "document", "verify", "review"] as const;
export type WorkflowStepId = (typeof WORKFLOW_STEP_IDS)[number];

export const WORKFLOW_STEP_DESCRIPTORS = {
  plan: { id: "plan", phase: "planning", actor: "planner" },
  implement: { id: "implement", phase: "implementing", actor: "worker" },
  document: { id: "document", phase: "documenting", actor: "documenter" },
  verify: { id: "verify", phase: "verifying", actor: "verifier" },
  review: { id: "review", phase: "reviewing", actor: "reviewer" },
} as const satisfies Record<WorkflowStepId, { id: WorkflowStepId; phase: string; actor: string }>;

export type WorkflowStepDescriptor = (typeof WORKFLOW_STEP_DESCRIPTORS)[WorkflowStepId];
export type WorkflowPhase = WorkflowStepDescriptor["phase"];
export type WorkflowActor = WorkflowStepDescriptor["actor"];

export function workflowStep<StepId extends WorkflowStepId>(
  stepId: StepId,
): (typeof WORKFLOW_STEP_DESCRIPTORS)[StepId] {
  return WORKFLOW_STEP_DESCRIPTORS[stepId];
}
