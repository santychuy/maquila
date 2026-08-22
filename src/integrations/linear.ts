import { createHash } from "node:crypto";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

export interface LinearSnapshot {
  uuid: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  assignee: { id: string; name: string; url: string };
  team: { id: string; name: string; key: string };
  state: { id: string; name: string; type: string };
  project?: { id: string; name: string };
  labels: { id: string; name: string }[];
  snapshotSha256: string;
}

export interface LinearDecisionRequest {
  commentId: string;
  commentUrl: string;
  issueId?: string;
  assigneeId?: string;
  generation?: number;
  questionSha256?: string;
  questionCount?: number;
  requestedAt?: string;
  marker?: string;
}

export const LINEAR_DECISION_MAX_PAGES = 10;
export const LINEAR_DECISION_MAX_REPLIES = 500;

export interface LinearDecisionReply {
  commentId: string;
  body: string;
  createdAt: string;
  sha256: string;
}

export class LinearIssueValidationError extends Error {}

export interface LinearOptions {
  fetch?: typeof globalThis.fetch;
  token: string;
  issue: string;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-blank`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is malformed`);
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function decisionMarker(runId: string, generation: number, questionSha256: string): string {
  return `<!-- maquila-decision:${runId}:${generation}:${questionSha256} -->`;
}

function timestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  return value;
}

async function requestLinear(
  options: Pick<LinearOptions, "fetch" | "token">,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(LINEAR_ENDPOINT, {
      method: "POST",
      headers: { Authorization: options.token, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new Error("Linear request failed");
  }
  if (!response.ok) throw new Error(`Linear HTTP request failed (${response.status})`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Linear response is malformed");
  }
  const root = record(body, "Linear response");
  if ("errors" in root && (!Array.isArray(root.errors) || root.errors.length > 0))
    throw new Error("Linear GraphQL request failed");
  return record(root.data, "Linear data");
}

export async function fetchLinearIssue(options: LinearOptions): Promise<LinearSnapshot> {
  text(options.token, "Linear token");
  text(options.issue, "issue");
  const issue = record(
    (
      await requestLinear(
        options,
        `query($id:String!){ issue(id:$id){ id identifier title description url assignee{id name url} team{id name key} state{id name type} project{id name} labels{nodes{id name}} } }`,
        { id: options.issue },
      )
    ).issue,
    "Linear issue",
  );
  if (issue.assignee === null)
    throw new LinearIssueValidationError("Linear issue must have an assignee");
  const assignee = record(issue.assignee, "assignee");
  const team = record(issue.team, "team");
  const state = record(issue.state, "state");
  const stateType = text(state.type, "state.type");
  if (stateType !== "unstarted" || text(state.name, "state.name") !== "Todo") {
    throw new LinearIssueValidationError("Linear issue must be Todo");
  }

  const labelNodes = record(issue.labels, "labels").nodes;
  if (!Array.isArray(labelNodes)) throw new Error("labels is malformed");
  const labels = labelNodes.map((value) => {
    const label = record(value, "label");
    return { id: text(label.id, "label.id"), name: text(label.name, "label.name") };
  });
  if (!("project" in issue)) throw new Error("project is malformed");
  const project =
    issue.project === null
      ? undefined
      : (() => {
          const value = record(issue.project, "project");
          return { id: text(value.id, "project.id"), name: text(value.name, "project.name") };
        })();
  const snapshot = {
    uuid: text(issue.id, "issue.id"),
    identifier: text(issue.identifier, "identifier"),
    title: text(issue.title, "title"),
    description: text(issue.description, "description"),
    url: text(issue.url, "url"),
    assignee: {
      id: text(assignee.id, "assignee.id"),
      name: text(assignee.name, "assignee.name"),
      url: text(assignee.url, "assignee.url"),
    },
    team: {
      id: text(team.id, "team.id"),
      name: text(team.name, "team.name"),
      key: text(team.key, "team.key"),
    },
    state: {
      id: text(state.id, "state.id"),
      name: text(state.name, "state.name"),
      type: stateType,
    },
    ...(project ? { project } : {}),
    labels,
  };
  return { ...snapshot, snapshotSha256: hash(snapshot) };
}

export async function createLinearDecisionComment(options: {
  fetch?: typeof globalThis.fetch;
  token: string;
  issueId: string;
  assigneeUrl: string;
  assigneeId?: string;
  runId: string;
  generation?: number;
  requestedAt?: string;
  decisions: string[];
}): Promise<LinearDecisionRequest> {
  text(options.token, "Linear token");
  text(options.issueId, "issue");
  if (!options.decisions.length || options.decisions.length > 10)
    throw new Error("planner decisions must contain 1 to 10 items");
  const decisions = options.decisions.map((decision) => text(decision, "planner decision"));
  if (decisions.some((decision) => decision.length > 2000))
    throw new Error("planner decision exceeds limit");
  const assigneeUrl = text(options.assigneeUrl, "assignee URL");
  if (!/^https:\/\/linear\.app\/[A-Za-z0-9_.~/-]+$/.test(assigneeUrl))
    throw new Error("assignee URL is invalid");
  if (!/^[0-9a-f-]{36}$/.test(options.runId)) throw new Error("run ID is invalid");
  const generation = options.generation ?? 1;
  if (!Number.isInteger(generation) || generation < 1 || generation > 3)
    throw new Error("decision generation is invalid");
  const assigneeId = options.assigneeId ? text(options.assigneeId, "assignee ID") : undefined;
  const requestedAt = timestamp(
    options.requestedAt ?? new Date().toISOString(),
    "request timestamp",
  );
  const questionSha256 = hash(decisions);
  const marker = decisionMarker(options.runId, generation, questionSha256);
  const body = [
    `${assigneeUrl} Maquila paused this run pending your decision.`,
    "",
    `Run: \`${options.runId}\` · Decision round: ${generation}`,
    "",
    ...decisions.map((decision, index) => `${index + 1}. ${decision}`),
    "",
    "Reply in this thread exactly in this form:",
    "Decision:",
    ...decisions.map((_, index) => `${index + 1}. <answer>`),
    "",
    "Maquila resumes this same run after a valid reply.",
    marker,
  ].join("\n");
  const result = (comment: { commentId: string; commentUrl: string }): LinearDecisionRequest => ({
    ...comment,
    issueId: options.issueId,
    ...(assigneeId ? { assigneeId } : {}),
    generation,
    questionSha256,
    questionCount: decisions.length,
    requestedAt,
    marker,
  });
  const existing = await findLinearDecisionComment({
    ...options,
    issueId: options.issueId,
    marker,
  });
  if (existing) return result(existing);
  let payload: Record<string, unknown>;
  try {
    payload = record(
      (
        await requestLinear(
          options,
          `mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success comment{id url} } }`,
          { input: { issueId: options.issueId, body } },
        )
      ).commentCreate,
      "Linear comment payload",
    );
  } catch (error) {
    const recovered = await findLinearDecisionComment({
      ...options,
      issueId: options.issueId,
      marker,
    });
    if (recovered) return result(recovered);
    throw error;
  }
  if (payload.success !== true) throw new Error("Linear comment creation failed");
  const comment = record(payload.comment, "Linear comment");
  return result({
    commentId: text(comment.id, "comment.id"),
    commentUrl: text(comment.url, "comment.url"),
  });
}

export async function findLinearDecisionComment(options: {
  fetch?: typeof globalThis.fetch;
  token: string;
  issueId: string;
  marker: string;
}): Promise<{ commentId: string; commentUrl: string } | undefined> {
  text(options.token, "Linear token");
  const issueId = text(options.issueId, "issue");
  const marker = text(options.marker, "decision marker");
  let after: string | null = null;
  const matches: Array<{ commentId: string; commentUrl: string }> = [];
  for (let page = 0; page < LINEAR_DECISION_MAX_PAGES; page += 1) {
    const issue = record(
      (
        await requestLinear(
          options,
          `query($id:String!,$after:String){ issue(id:$id){ id comments(first:50,after:$after){ nodes{id url body} pageInfo{hasNextPage endCursor} } } }`,
          { id: issueId, after },
        )
      ).issue,
      "Linear issue",
    );
    if (text(issue.id, "issue.id") !== issueId) throw new Error("Linear issue identity mismatch");
    const comments = record(issue.comments, "issue comments");
    if (!Array.isArray(comments.nodes)) throw new Error("decision comments are malformed");
    for (const value of comments.nodes) {
      const comment = record(value, "decision comment");
      if (text(comment.body, "comment body").includes(marker))
        matches.push({
          commentId: text(comment.id, "comment.id"),
          commentUrl: text(comment.url, "comment.url"),
        });
    }
    if (matches.length > 1) throw new Error("Linear decision comment is ambiguous");
    const pageInfo = record(comments.pageInfo, "decision comment page info");
    if (pageInfo.hasNextPage === false) return matches[0];
    if (pageInfo.hasNextPage !== true || !text(pageInfo.endCursor, "decision comment cursor"))
      throw new Error("decision comment pagination is malformed");
    after = text(pageInfo.endCursor, "decision comment cursor");
  }
  throw new Error("decision comment search exceeds limit");
}

export async function fetchLinearDecisionReply(options: {
  fetch?: typeof globalThis.fetch;
  token: string;
  commentId?: string;
  request?: LinearDecisionRequest;
}): Promise<LinearDecisionReply | undefined> {
  text(options.token, "Linear token");
  const request = options.request;
  const commentId = text(request?.commentId ?? options.commentId, "comment ID");
  const pinnedAssignee = request?.assigneeId;
  const issueId = request?.issueId;
  const requestedAt = request?.requestedAt && timestamp(request.requestedAt, "request timestamp");
  if (request) {
    if (!pinnedAssignee || !issueId || !requestedAt || !request.marker || !request.questionSha256)
      throw new Error("decision request is incomplete");
    if (!Number.isInteger(request.generation) || !Number.isInteger(request.questionCount))
      throw new Error("decision request is invalid");
    const marker = request.marker.match(
      /^<!-- maquila-decision:[0-9a-f-]{36}:(\d+):([0-9a-f]{64}) -->$/,
    );
    if (!marker || Number(marker[1]) !== request.generation || marker[2] !== request.questionSha256)
      throw new Error("decision request marker is invalid");
  }
  const replies: Array<{ commentId: string; body: string; createdAt: string; userId?: string }> =
    [];
  let after: string | null = null;
  for (let page = 0; page < LINEAR_DECISION_MAX_PAGES; page += 1) {
    const comment = record(
      (
        await requestLinear(
          options,
          `query($id:String!,$after:String){ comment(id:$id){ id body issue{id assignee{id}} children(first:50,after:$after){ nodes{id body createdAt user{id}} pageInfo{hasNextPage endCursor} } } }`,
          { id: commentId, after },
        )
      ).comment,
      "Linear comment",
    );
    if (text(comment.id, "comment.id") !== commentId)
      throw new Error("Linear comment identity mismatch");
    const issue = record(comment.issue, "comment issue");
    if (request) {
      if (text(issue.id, "comment issue.id") !== issueId)
        throw new Error("Linear decision issue mismatch");
      if (!text(comment.body, "comment body").includes(request.marker!))
        throw new Error("Linear decision generation mismatch");
    }
    const assigneeId = pinnedAssignee ?? text(record(issue.assignee, "assignee").id, "assignee.id");
    const children = record(comment.children, "comment children");
    if (!Array.isArray(children.nodes)) throw new Error("comment replies are malformed");
    for (const value of children.nodes) {
      const reply = record(value, "comment reply");
      const body = text(reply.body, "comment body").trim();
      const createdAt = timestamp(text(reply.createdAt, "comment createdAt"), "comment timestamp");
      const user = reply.user === null ? undefined : record(reply.user, "comment user");
      if (user && text(user.id, "comment user.id") === assigneeId && body.startsWith("Decision:"))
        replies.push({
          commentId: text(reply.id, "comment.id"),
          body,
          createdAt,
          userId: assigneeId,
        });
      if (replies.length > LINEAR_DECISION_MAX_REPLIES)
        throw new Error("Linear decision thread exceeds limit");
    }
    const pageInfo = record(children.pageInfo, "comment page info");
    if (pageInfo.hasNextPage === false) break;
    if (pageInfo.hasNextPage !== true || !text(pageInfo.endCursor, "comment cursor"))
      throw new Error("Linear decision pagination is malformed");
    after = text(pageInfo.endCursor, "comment cursor");
    if (page === LINEAR_DECISION_MAX_PAGES - 1)
      throw new Error("Linear decision thread exceeds limit");
  }
  const reply = replies
    .filter((candidate) => {
      if (!request) return true;
      if (Date.parse(candidate.createdAt) <= Date.parse(requestedAt!)) return false;
      const lines = candidate.body.slice("Decision:".length).trim().split("\n").filter(Boolean);
      return (
        lines.length === request.questionCount &&
        lines.every(
          (line, index) => line.trim().startsWith(`${index + 1}. `) && line.trim().length > 3,
        )
      );
    })
    .toSorted(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.commentId.localeCompare(left.commentId),
    )[0];
  if (!reply) return undefined;
  const body = reply.body.slice("Decision:".length).trim();
  if (!body || body.length > 4000) throw new Error("Linear decision reply is invalid");
  return {
    commentId: reply.commentId,
    body,
    createdAt: reply.createdAt,
    sha256: hash({ commentId: reply.commentId, body, createdAt: reply.createdAt }),
  };
}
