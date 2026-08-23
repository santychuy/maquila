export const WORKFLOW_STEP_IDS = ["plan", "implement", "document", "verify", "review"] as const;
export type WorkflowStepId = (typeof WORKFLOW_STEP_IDS)[number];

export const WORKFLOW_STEP_DESCRIPTORS = {
  plan: { id: "plan", phase: "planning", actor: "planner", actorKind: "agent" },
  implement: { id: "implement", phase: "implementing", actor: "worker", actorKind: "agent" },
  document: { id: "document", phase: "documenting", actor: "documenter", actorKind: "agent" },
  verify: { id: "verify", phase: "verifying", actor: "verifier", actorKind: "code" },
  review: { id: "review", phase: "reviewing", actor: "reviewer", actorKind: "agent" },
} as const satisfies Record<
  WorkflowStepId,
  { id: WorkflowStepId; phase: string; actor: string; actorKind: "agent" | "code" }
>;

export type WorkflowStepDescriptor = (typeof WORKFLOW_STEP_DESCRIPTORS)[WorkflowStepId];
export type WorkflowPhase = WorkflowStepDescriptor["phase"];
export type WorkflowActor = WorkflowStepDescriptor["actor"];
export type WorkflowActorKind = WorkflowStepDescriptor["actorKind"];

export function workflowStep<StepId extends WorkflowStepId>(
  stepId: StepId,
): (typeof WORKFLOW_STEP_DESCRIPTORS)[StepId] {
  return WORKFLOW_STEP_DESCRIPTORS[stepId];
}
