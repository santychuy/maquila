import { createHash } from "node:crypto";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

export interface LinearSnapshot {
  uuid: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  team: { id: string; name: string; key: string };
  state: { id: string; name: string; type: string };
  project?: { id: string; name: string };
  labels: { id: string; name: string }[];
  snapshotSha256: string;
}

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

export async function fetchLinearIssue(options: LinearOptions): Promise<LinearSnapshot> {
  text(options.token, "Linear token");
  text(options.issue, "issue");
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(LINEAR_ENDPOINT, {
      method: "POST",
      headers: { Authorization: options.token, "content-type": "application/json" },
      body: JSON.stringify({
        query: `query($id:String!){ issue(id:$id){ id identifier title description url team{id name key} state{id name type} project{id name} labels{nodes{id name}} } }`,
        variables: { id: options.issue },
      }),
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
  if ("errors" in root && (!Array.isArray(root.errors) || root.errors.length > 0)) {
    throw new Error("Linear GraphQL request failed");
  }
  const issue = record(record(root.data, "Linear data").issue, "Linear issue");
  const team = record(issue.team, "team");
  const state = record(issue.state, "state");
  const stateType = text(state.type, "state.type");
  if (stateType !== "unstarted" || text(state.name, "state.name") !== "Todo") {
    throw new Error("Linear issue must be Todo");
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
