import { runController, type ControllerOptions, type ControllerResult } from "./controller.js";
import { fetchLinearDecisionReply, type LinearDecisionReply } from "./integrations/linear.js";

export async function waitForLinearDecision(options: {
  token: string;
  commentId: string;
  intervalMilliseconds?: number;
  fetchDecision?: typeof fetchLinearDecisionReply;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<LinearDecisionReply> {
  const interval = options.intervalMilliseconds ?? 30_000;
  if (!Number.isInteger(interval) || interval < 1)
    throw new Error("decision poll interval must be a positive integer");
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));
  for (;;) {
    try {
      const decision = await (options.fetchDecision ?? fetchLinearDecisionReply)({
        token: options.token,
        commentId: options.commentId,
      });
      if (decision) return decision;
    } catch {}
    await sleep(interval);
  }
}

export async function runControllerChain(
  options: ControllerOptions & {
    run?: typeof runController;
    waitForDecision?: typeof waitForLinearDecision;
  },
): Promise<ControllerResult> {
  const { run = runController, waitForDecision = waitForLinearDecision, ...initial } = options;
  let current: ControllerOptions = initial;
  for (;;) {
    const result = await run(current);
    if (result.status !== "awaiting_decision" || !result.decisionRequest) return result;
    const decision = await waitForDecision({
      token: current.linearToken,
      commentId: result.decisionRequest.commentId,
    });
    current = {
      ...current,
      runId: result.decisionRequest.continuationRunId,
      decision: {
        ...decision,
        previousRunId: result.decisionRequest.runId,
        requestCommentId: result.decisionRequest.commentId,
      },
      onAccepted: undefined,
    };
  }
}
