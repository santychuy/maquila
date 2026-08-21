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
}

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
  runId: string;
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
  const body = [
    `${assigneeUrl} Factory needs your decision before implementation can continue.`,
    "",
    `Run: \`${options.runId}\``,
    "",
    ...decisions.map((decision, index) => `${index + 1}. ${decision}`),
    "",
    "Reply in this thread with `Decision: <your answer>`. Factory will start a fresh linked run automatically.",
  ].join("\n");
  const payload = record(
    (
      await requestLinear(
        options,
        `mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success comment{id url} } }`,
        { input: { issueId: options.issueId, body } },
      )
    ).commentCreate,
    "Linear comment payload",
  );
  if (payload.success !== true) throw new Error("Linear comment creation failed");
  const comment = record(payload.comment, "Linear comment");
  return {
    commentId: text(comment.id, "comment.id"),
    commentUrl: text(comment.url, "comment.url"),
  };
}

export async function fetchLinearDecisionReply(options: {
  fetch?: typeof globalThis.fetch;
  token: string;
  commentId: string;
}): Promise<LinearDecisionReply | undefined> {
  text(options.token, "Linear token");
  text(options.commentId, "comment ID");
  const comment = record(
    (
      await requestLinear(
        options,
        `query($id:String!){ comment(id:$id){ id issue{assignee{id}} children(first:50){ nodes{id body createdAt user{id}} pageInfo{hasNextPage} } } }`,
        { id: options.commentId },
      )
    ).comment,
    "Linear comment",
  );
  if (text(comment.id, "comment.id") !== options.commentId)
    throw new Error("Linear comment identity mismatch");
  const assignee = record(record(comment.issue, "comment issue").assignee, "assignee");
  const assigneeId = text(assignee.id, "assignee.id");
  const children = record(comment.children, "comment children");
  const pageInfo = record(children.pageInfo, "comment page info");
  if (pageInfo.hasNextPage !== false) throw new Error("Linear decision thread exceeds limit");
  if (!Array.isArray(children.nodes)) throw new Error("comment replies are malformed");
  const replies = children.nodes
    .map((value) => {
      const reply = record(value, "comment reply");
      const body = text(reply.body, "comment body").trim();
      const createdAt = text(reply.createdAt, "comment createdAt");
      if (!Number.isFinite(Date.parse(createdAt))) throw new Error("comment timestamp is invalid");
      const user = reply.user === null ? undefined : record(reply.user, "comment user");
      return {
        commentId: text(reply.id, "comment.id"),
        body,
        createdAt,
        userId: user ? text(user.id, "comment user.id") : undefined,
      };
    })
    .filter((reply) => reply.userId === assigneeId && reply.body.startsWith("Decision:"))
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  const reply = replies[0];
  if (!reply) return undefined;
  const decision = reply.body.slice("Decision:".length).trim();
  if (!decision || decision.length > 4000) throw new Error("Linear decision reply is invalid");
  return {
    commentId: reply.commentId,
    body: decision,
    createdAt: reply.createdAt,
    sha256: hash({ commentId: reply.commentId, body: decision, createdAt: reply.createdAt }),
  };
}
