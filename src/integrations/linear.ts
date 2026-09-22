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

export const AUTOMATIC_LINEAR_LABEL = "maquila-ready";

export function isAutomaticLinearCandidate(
  snapshot: Pick<LinearSnapshot, "assignee" | "state" | "labels">,
): boolean {
  return (
    Boolean(snapshot.assignee) &&
    snapshot.state.type === "unstarted" &&
    snapshot.state.name === "Todo" &&
    snapshot.labels.some((label) => label.name === AUTOMATIC_LINEAR_LABEL)
  );
}

export interface LinearOptions {
  fetch?: typeof globalThis.fetch;
  token: string;
  issue: string;
}

export async function fetchSingleLinearTeamId(options: {
  fetch?: typeof globalThis.fetch;
  token: string;
}): Promise<string> {
  const connection = record(
    (await requestLinear(options, `query { teams(first:2){ nodes{id} } }`, {})).teams,
    "Linear teams",
  );
  if (!Array.isArray(connection.nodes) || connection.nodes.length !== 1)
    throw new Error("automatic intake requires exactly one Linear team");
  return text(record(connection.nodes[0], "Linear team").id, "Linear team.id");
}

export interface LinearCandidate {
  id: string;
  identifier: string;
  updatedAt: string;
}

export async function listLinearAutomaticCandidates(options: {
  fetch?: typeof globalThis.fetch;
  token: string;
  teamId?: string;
  after?: string;
  first?: number;
}): Promise<{ candidates: LinearCandidate[]; endCursor?: string; hasNextPage: boolean }> {
  text(options.token, "Linear token");
  const first = options.first ?? 50;
  if (!Number.isInteger(first) || first < 1 || first > 50)
    throw new Error("Linear candidate page size invalid");
  const filter = options.teamId
    ? '{assignee:{null:false},state:{type:{eq:"unstarted"},name:{eq:"Todo"}},labels:{some:{name:{eq:"maquila-ready"}}},team:{id:{eq:$teamId}}}'
    : '{assignee:{null:false},state:{type:{eq:"unstarted"},name:{eq:"Todo"}},labels:{some:{name:{eq:"maquila-ready"}}}}';
  const data = await requestLinear(
    { ...options, signal: AbortSignal.timeout(10_000) },
    `query($after:String${options.teamId ? ",$teamId:String" : ""}){issues(first:${first},after:$after,orderBy:updatedAt,filter:${filter}){edges{cursor node{id identifier updatedAt}} pageInfo{hasNextPage endCursor}}}`,
    { after: options.after ?? null, ...(options.teamId ? { teamId: options.teamId } : {}) },
  );
  const connection = record(data.issues, "Linear issues");
  const edges = connection.edges;
  if (!Array.isArray(edges) || edges.length > first)
    throw new Error("Linear candidate page malformed");
  const pageInfo = record(connection.pageInfo, "Linear candidate pageInfo");
  if (typeof pageInfo.hasNextPage !== "boolean")
    throw new Error("Linear candidate pageInfo malformed");
  const endCursor = pageInfo.endCursor === null ? undefined : text(pageInfo.endCursor, "endCursor");
  const candidates = edges.map((edge, index) => {
    const value = record(edge, `Linear candidate edge ${index}`);
    text(value.cursor, "candidate cursor");
    const node = record(value.node, `Linear candidate ${index}`);
    const id = text(node.id, "candidate id");
    const identifier = text(node.identifier, "candidate identifier");
    const updatedAt = timestamp(text(node.updatedAt, "candidate updatedAt"), "candidate updatedAt");
    return { id, identifier, updatedAt };
  });
  return { candidates, ...(endCursor ? { endCursor } : {}), hasNextPage: pageInfo.hasNextPage };
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
  options: Pick<LinearOptions, "fetch" | "token"> & { signal?: AbortSignal },
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(LINEAR_ENDPOINT, {
      method: "POST",
      headers: { Authorization: options.token, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: options.signal,
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

export interface LinearIdentity {
  user: { id: string; name: string };
  workspace: { id: string; name: string; urlKey: string };
}

export async function fetchLinearIdentity(
  options: Pick<LinearOptions, "fetch" | "token">,
): Promise<LinearIdentity> {
  text(options.token, "Linear token");
  const data = await requestLinear(
    { ...options, signal: AbortSignal.timeout(10_000) },
    "{ viewer { id name } organization { id name urlKey } }",
    {},
  );
  const viewer = record(data.viewer, "viewer");
  const organization = record(data.organization, "organization");
  return {
    user: { id: text(viewer.id, "viewer.id"), name: text(viewer.name, "viewer.name") },
    workspace: {
      id: text(organization.id, "organization.id"),
      name: text(organization.name, "organization.name"),
      urlKey: text(organization.urlKey, "organization.urlKey"),
    },
  };
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

export async function createLinearAutomaticWebhook(options: {
  fetch?: typeof globalThis.fetch;
  token: string;
  url: string;
  secret: string;
  label: string;
  teamId: string;
}): Promise<{ id: string }> {
  text(options.token, "Linear token");
  const url = new URL(text(options.url, "webhook URL"));
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Linear webhook URL is invalid");
  const secret = text(options.secret, "webhook secret");
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("webhook secret is invalid");
  const label = text(options.label, "webhook label");
  if (label.length > 100) throw new Error("webhook label is invalid");
  const teamId = text(options.teamId, "Linear team ID");
  const existing = await listLinearAutomaticWebhooks(options);
  const matches = existing.filter((webhook) => webhook.url === url.href || webhook.label === label);
  if (matches.length > 1) throw new Error("Linear automatic webhook is ambiguous");
  if (matches[0]) {
    if (matches[0].url !== url.href || matches[0].label !== label || !matches[0].enabled)
      throw new Error("Linear automatic webhook conflicts with existing configuration");
    return { id: matches[0].id };
  }
  const created = record(
    (
      await requestLinear(
        options,
        `mutation($input:WebhookCreateInput!){ webhookCreate(input:$input){ success webhook{id enabled url label} } }`,
        {
          input: {
            url: url.href,
            secret,
            label,
            teamId,
            resourceTypes: ["Issue"],
          },
        },
      )
    ).webhookCreate,
    "Linear webhook payload",
  );
  if (created.success !== true) throw new Error("Linear webhook creation failed");
  const webhook = record(created.webhook, "Linear webhook");
  const id = text(webhook.id, "webhook.id");
  if (!/^[0-9a-f-]{36}$/.test(id) || webhook.enabled !== true)
    throw new Error("Linear webhook creation returned invalid state");
  return { id };
}

export async function listLinearAutomaticWebhooks(options: {
  fetch?: typeof globalThis.fetch;
  token: string;
}): Promise<Array<{ id: string; url: string; label: string; enabled: boolean }>> {
  const webhooks: Array<{ id: string; url: string; label: string; enabled: boolean }> = [];
  let after: string | null = null;
  for (let page = 0; page < LINEAR_DECISION_MAX_PAGES; page += 1) {
    const connection = record(
      (
        await requestLinear(
          options,
          `query($after:String){ webhooks(first:50,after:$after){ nodes{id url label enabled} pageInfo{hasNextPage endCursor} } }`,
          { after },
        )
      ).webhooks,
      "Linear webhooks",
    );
    if (!Array.isArray(connection.nodes)) throw new Error("Linear webhooks are malformed");
    for (const item of connection.nodes) {
      const webhook = record(item, "Linear webhook");
      const id = text(webhook.id, "webhook.id");
      if (!/^[0-9a-f-]{36}$/.test(id) || typeof webhook.enabled !== "boolean")
        throw new Error("Linear webhook is malformed");
      webhooks.push({
        id,
        url: text(webhook.url, "webhook.url"),
        label: text(webhook.label, "webhook.label"),
        enabled: webhook.enabled,
      });
    }
    const pageInfo = record(connection.pageInfo, "Linear webhook pageInfo");
    if (pageInfo.hasNextPage === false) return webhooks;
    if (pageInfo.hasNextPage !== true || !text(pageInfo.endCursor, "webhook cursor"))
      throw new Error("Linear webhook pagination is malformed");
    after = text(pageInfo.endCursor, "webhook cursor");
  }
  throw new Error("Linear webhook search exceeds limit");
}

export async function deleteLinearAutomaticWebhook(options: {
  fetch?: typeof globalThis.fetch;
  token: string;
  id: string;
}): Promise<void> {
  const id = text(options.id, "webhook ID");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("webhook ID is invalid");
  const payload = record(
    (
      await requestLinear(options, `mutation($id:String!){ webhookDelete(id:$id){ success } }`, {
        id,
      })
    ).webhookDelete,
    "Linear webhook deletion payload",
  );
  if (payload.success !== true) throw new Error("Linear webhook deletion failed");
}

export async function createLinearAutomaticRunComment(options: {
  fetch?: typeof globalThis.fetch;
  token: string;
  issueId: string;
  runId: string;
  dashboardUrl: string;
  expiresAt: string;
}): Promise<{ commentId: string; commentUrl: string }> {
  text(options.token, "Linear token");
  const issueId = text(options.issueId, "issue");
  if (!/^[0-9a-f-]{36}$/.test(options.runId)) throw new Error("run ID is invalid");
  const expiresAt = timestamp(options.expiresAt, "dashboard expiry");
  const dashboard = new URL(text(options.dashboardUrl, "dashboard URL"));
  if (
    dashboard.protocol !== "https:" ||
    dashboard.username ||
    dashboard.password ||
    dashboard.hash ||
    dashboard.href.length > 2_048
  )
    throw new Error("dashboard URL is invalid");
  const marker = `<!-- maquila-run:${options.runId} -->`;
  const existing = await findLinearDecisionComment({ ...options, issueId, marker });
  if (existing) return existing;
  const body = [
    "Maquila accepted this automatic run.",
    "",
    `Run: \`${options.runId}\``,
    `Live dashboard (expires ${expiresAt}): ${dashboard.href}`,
    "",
    marker,
  ].join("\n");
  try {
    const payload = record(
      (
        await requestLinear(
          options,
          `mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success comment{id url} } }`,
          { input: { issueId, body } },
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
  } catch (error) {
    const recovered = await findLinearDecisionComment({ ...options, issueId, marker });
    if (recovered) return recovered;
    throw error;
  }
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
