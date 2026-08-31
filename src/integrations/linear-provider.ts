import {
  type DecisionReceipt,
  type DecisionReply,
  type DecisionRequest,
  type WorkItemProvider,
  type WorkItemSnapshot,
  validateWorkItemReference,
} from "../providers.js";
import {
  createLinearDecisionComment,
  fetchLinearDecisionReply,
  fetchLinearIssue,
  type LinearDecisionRequest,
  type LinearOptions,
  type LinearSnapshot,
} from "./linear.js";

export const LINEAR_PROVIDER = "linear";
function safe(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && !/[\r\n\0]/.test(value);
}
function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}
export interface LinearWorkItemSnapshot extends WorkItemSnapshot {
  readonly linear: LinearSnapshot;
}
/** Durable neutral mapping of the existing Linear decision protocol. */
export interface LinearDecisionReceipt extends DecisionReceipt {}
export interface LinearWorkItemProviderOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
  fetchIssue?: (options: LinearOptions) => Promise<LinearSnapshot>;
  createDecisionComment?: typeof createLinearDecisionComment;
  fetchDecisionReply?: typeof fetchLinearDecisionReply;
}
/** Creates a Linear-backed work-item provider. The token remains private to the instance. */
export function createLinearWorkItemProvider(
  options: LinearWorkItemProviderOptions,
): WorkItemProvider {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new Error("Linear provider options must be an object");
  if (
    Object.keys(options).some(
      (key) =>
        !["token", "fetch", "fetchIssue", "createDecisionComment", "fetchDecisionReply"].includes(
          key,
        ),
    )
  )
    throw new Error("Linear provider options have unknown fields");
  if (!safe(options.token)) throw new Error("Linear token is invalid");
  return new LinearWorkItemProvider(options);
}

export class LinearWorkItemProvider implements WorkItemProvider {
  private readonly options: LinearWorkItemProviderOptions;
  constructor(options: LinearWorkItemProviderOptions) {
    this.options = options;
  }
  async fetchWorkItem(reference: unknown): Promise<LinearWorkItemSnapshot> {
    const parsed = validateWorkItemReference(reference, LINEAR_PROVIDER);
    const snapshot = await (this.options.fetchIssue ?? fetchLinearIssue)({
      token: this.options.token,
      issue: parsed.id,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      !safe(snapshot.uuid) ||
      !safe(snapshot.title) ||
      !safe(snapshot.description) ||
      !safe(snapshot.url) ||
      !safe(snapshot.assignee?.id) ||
      !safe(snapshot.assignee?.name) ||
      !safe(snapshot.assignee?.url) ||
      !sha256(snapshot.snapshotSha256)
    )
      throw new Error("Linear work item is malformed");
    if (snapshot.identifier !== parsed.id) throw new Error("Linear work item reference mismatch");
    return {
      provider: LINEAR_PROVIDER,
      id: snapshot.uuid,
      key: snapshot.identifier,
      title: snapshot.title,
      body: snapshot.description,
      url: snapshot.url,
      snapshotSha256: snapshot.snapshotSha256,
      decisionPrincipal: {
        id: snapshot.assignee.id,
        name: snapshot.assignee.name,
        url: snapshot.assignee.url,
      },
      linear: snapshot,
    };
  }
  async requestDecision(
    reference: unknown,
    request: DecisionRequest,
  ): Promise<LinearDecisionReceipt> {
    const parsed = validateWorkItemReference(reference, LINEAR_PROVIDER);
    if (
      request.workItem.provider !== LINEAR_PROVIDER ||
      request.workItem.key !== parsed.id ||
      request.principal.id !== request.workItem.decisionPrincipal?.id ||
      request.principal.url !== request.workItem.decisionPrincipal?.url
    )
      throw new Error("Linear decision request identity mismatch");
    const linear = await (this.options.createDecisionComment ?? createLinearDecisionComment)({
      token: this.options.token,
      issueId: request.workItem.id,
      assigneeUrl: request.principal.url,
      assigneeId: request.principal.id,
      runId: request.runId,
      ...(request.generation === undefined ? {} : { generation: request.generation }),
      ...(request.requestedAt === undefined ? {} : { requestedAt: request.requestedAt }),
      decisions: request.decisions,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    if (
      !linear.issueId ||
      !linear.assigneeId ||
      linear.generation === undefined ||
      !linear.questionSha256 ||
      linear.questionCount === undefined ||
      !linear.requestedAt ||
      !linear.marker
    )
      throw new Error("Linear decision receipt is incomplete");
    return {
      provider: LINEAR_PROVIDER,
      commentId: linear.commentId,
      commentUrl: linear.commentUrl,
      workItemId: linear.issueId,
      principalId: linear.assigneeId,
      generation: linear.generation,
      questionSha256: linear.questionSha256,
      questionCount: linear.questionCount,
      requestedAt: linear.requestedAt,
      marker: linear.marker,
    };
  }
  async waitForDecision(
    reference: unknown,
    receipt: DecisionReceipt,
  ): Promise<DecisionReply | undefined> {
    validateWorkItemReference(reference, LINEAR_PROVIDER);
    if (
      receipt.provider !== LINEAR_PROVIDER ||
      receipt.workItemId.length === 0 ||
      receipt.principalId.length === 0 ||
      receipt.generation < 1 ||
      !sha256(receipt.questionSha256) ||
      receipt.questionCount < 1 ||
      !safe(receipt.requestedAt) ||
      !safe(receipt.marker)
    )
      throw new Error("Linear decision receipt is incomplete");
    const linear: LinearDecisionRequest = {
      commentId: receipt.commentId,
      commentUrl: receipt.commentUrl,
      issueId: receipt.workItemId,
      assigneeId: receipt.principalId,
      generation: receipt.generation,
      questionSha256: receipt.questionSha256,
      questionCount: receipt.questionCount,
      requestedAt: receipt.requestedAt,
      marker: receipt.marker,
    };
    return (this.options.fetchDecisionReply ?? fetchLinearDecisionReply)({
      token: this.options.token,
      request: linear,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
  }
}
