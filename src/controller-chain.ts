import {
  runController,
  type ControllerDecisionRequest,
  type ControllerOptions,
  type ControllerResult,
} from "./controller.js";
import { fetchLinearDecisionReply, type LinearDecisionReply } from "./integrations/linear.js";
import type { DecisionReply, DecisionReceipt, WorkItemProvider } from "./providers.js";

export async function waitForLinearDecision(options: {
  token: string;
  commentId: string;
  request?: ControllerDecisionRequest;
  expiresAt?: string;
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
  const expiresAt = options.expiresAt ? Date.parse(options.expiresAt) : undefined;
  if (expiresAt !== undefined && !Number.isFinite(expiresAt))
    throw new Error("decision expiry must be a timestamp");
  const fetchDecision = options.fetchDecision ?? fetchLinearDecisionReply;
  for (;;) {
    if (expiresAt !== undefined && Date.now() >= expiresAt)
      throw new Error("decision wait expired");
    try {
      const decision = await fetchDecision({
        token: options.token,
        commentId: options.commentId,
        ...(options.request ? { request: options.request } : {}),
      });
      if (decision) {
        if (
          expiresAt !== undefined &&
          (Date.now() >= expiresAt || Date.parse(decision.createdAt) > expiresAt)
        )
          throw new Error("decision wait expired");
        return decision;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "decision wait expired") throw error;
      if (!options.fetchDecision) {
        if (
          message !== "Linear request failed" &&
          !/^Linear HTTP request failed \((429|5\d\d)\)$/.test(message)
        )
          throw error;
      }
    }
    await sleep(interval);
  }
}

export async function waitForProviderDecision(options: {
  provider: WorkItemProvider;
  reference: unknown;
  receipt: DecisionReceipt;
  expiresAt?: string;
  intervalMilliseconds?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<DecisionReply> {
  const interval = options.intervalMilliseconds ?? 30_000;
  if (!Number.isInteger(interval) || interval < 1)
    throw new Error("decision poll interval must be a positive integer");
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  const expiresAt = options.expiresAt ? Date.parse(options.expiresAt) : undefined;
  if (expiresAt !== undefined && !Number.isFinite(expiresAt))
    throw new Error("decision expiry must be a timestamp");
  for (;;) {
    if (expiresAt !== undefined && Date.now() >= expiresAt)
      throw new Error("decision wait expired");
    try {
      const decision = await options.provider.waitForDecision(options.reference, options.receipt);
      if (decision) {
        if (
          expiresAt !== undefined &&
          (Date.now() >= expiresAt || Date.parse(decision.createdAt) > expiresAt)
        )
          throw new Error("decision wait expired");
        return decision;
      }
    } catch (error) {
      if ((error instanceof Error ? error.message : String(error)) === "decision wait expired")
        throw error;
      // Provider polling is deliberately transient: a later poll owns final availability.
    }
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
    const result = await run({
      ...current,
      inlineDecisionWaiter: (request, expiresAt) =>
        current.infrastructure
          ? request.providerReceipt
            ? waitForProviderDecision({
                provider: current.infrastructure.workItems,
                reference: current.infrastructure.workItemReference,
                receipt: request.providerReceipt,
                expiresAt,
              })
            : Promise.reject(new Error("provider decision receipt missing"))
          : waitForDecision({
              token: current.linearToken,
              commentId: request.commentId,
              request,
              expiresAt,
            }),
    });
    if (result.status !== "awaiting_decision" || !result.decisionRequest) return result;
    current = {
      ...current,
      runId: result.decisionRequest.runId,
      resumeExisting: true,
      onAccepted: undefined,
    };
  }
}
