import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchGitHubSnapshot, publishGitHubPullRequest } from "../src/integrations/github.js";
import { createIntake } from "../src/intake.js";
import {
  createLinearDecisionComment,
  fetchLinearDecisionReply,
  fetchLinearIssue,
} from "../src/integrations/linear.js";

interface FetchReply {
  body?: unknown;
  raw?: string;
  status?: number;
  error?: Error;
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function sequence(replies: FetchReply[]): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected fetch");
    if (reply.error) throw reply.error;
    return new Response(reply.raw ?? JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetcher, calls };
}

function linearIssue(state = "Todo") {
  return {
    data: {
      issue: {
        id: "7c3cd7a0-2503-40fe-9f33-56588786452a",
        identifier: "RIFF-39",
        title: "Assess native components",
        description: "Map current architecture.",
        url: "https://linear.app/example/RIFF-39",
        assignee: {
          id: "user-1",
          name: "Santiago",
          url: "https://linear.app/example/profiles/santiago",
        },
        team: { id: "team-1", name: "Riffmark", key: "RIFF" },
        state: { id: "state-1", name: state, type: state === "Todo" ? "unstarted" : "backlog" },
        project: null,
        labels: { nodes: [{ id: "label-1", name: "architecture" }] },
      },
    },
  };
}

const repository = {
  id: 123,
  full_name: "santychuy/bookbounce",
  private: true,
  default_branch: "main",
};
const reference = {
  ref: "refs/heads/main",
  object: { type: "commit", sha: "a".repeat(40) },
};

test("Linear key and UUID produce stable Todo snapshots", async () => {
  const keyFetch = sequence([{ body: linearIssue() }]);
  const uuidFetch = sequence([{ body: linearIssue() }]);
  const byKey = await fetchLinearIssue({
    fetch: keyFetch.fetch,
    token: "linear-secret",
    issue: "RIFF-39",
  });
  const byUuid = await fetchLinearIssue({
    fetch: uuidFetch.fetch,
    token: "linear-secret",
    issue: "7c3cd7a0-2503-40fe-9f33-56588786452a",
  });
  assert.equal(byKey.snapshotSha256, byUuid.snapshotSha256);
  assert.equal(byKey.identifier, "RIFF-39");
  assert.equal(byKey.assignee.id, "user-1");
  const requestBody = keyFetch.calls[0]?.init?.body;
  if (typeof requestBody !== "string") assert.fail("expected JSON request body");
  const request = JSON.parse(requestBody) as { variables: { id: string } };
  assert.equal(request.variables.id, "RIFF-39");
  assert.equal(new Headers(keyFetch.calls[0]?.init?.headers).get("Authorization"), "linear-secret");
});

test("Linear rejects non-Todo, GraphQL errors, and malformed partial data", async () => {
  await assert.rejects(
    () =>
      fetchLinearIssue({
        fetch: sequence([{ body: linearIssue("Backlog") }]).fetch,
        token: "x",
        issue: "RIFF-39",
      }),
    /must be Todo/,
  );
  await assert.rejects(
    () =>
      fetchLinearIssue({
        fetch: sequence([{ body: { errors: [{ message: "no" }] } }]).fetch,
        token: "x",
        issue: "RIFF-39",
      }),
    /GraphQL request failed/,
  );
  await assert.rejects(
    () =>
      fetchLinearIssue({
        fetch: sequence([{ body: { ...linearIssue(), errors: {} } }]).fetch,
        token: "x",
        issue: "RIFF-39",
      }),
    /GraphQL request failed/,
  );
  const missingProject = linearIssue();
  Reflect.deleteProperty(missingProject.data.issue, "project");
  await assert.rejects(
    () =>
      fetchLinearIssue({
        fetch: sequence([{ body: missingProject }]).fetch,
        token: "x",
        issue: "RIFF-39",
      }),
    /project is malformed/,
  );
  const partial = linearIssue();
  partial.data.issue.description = "";
  await assert.rejects(
    () =>
      fetchLinearIssue({
        fetch: sequence([{ body: partial }]).fetch,
        token: "x",
        issue: "RIFF-39",
      }),
    /description must be non-blank/,
  );
  const unassigned = linearIssue();
  unassigned.data.issue.assignee = null as never;
  await assert.rejects(
    () =>
      fetchLinearIssue({
        fetch: sequence([{ body: unassigned }]).fetch,
        token: "x",
        issue: "RIFF-39",
      }),
    /must have an assignee/,
  );
});

test("Linear decision comments mention assignee and accept latest assigned Decision reply", async () => {
  const created = sequence([
    {
      body: {
        data: {
          issue: {
            id: "issue-1",
            comments: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      },
    },
    {
      body: {
        data: {
          commentCreate: {
            success: true,
            comment: { id: "comment-1", url: "https://linear.app/example/comment-1" },
          },
        },
      },
    },
  ]);
  assert.deepEqual(
    await createLinearDecisionComment({
      fetch: created.fetch,
      token: "secret",
      issueId: "issue-1",
      assigneeId: "user-1",
      assigneeUrl: "https://linear.app/example/profiles/santiago",
      runId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      requestedAt: "2026-01-01T00:00:00.000Z",
      decisions: ["Keep the sign-in card?"],
    }),
    {
      commentId: "comment-1",
      commentUrl: "https://linear.app/example/comment-1",
      issueId: "issue-1",
      assigneeId: "user-1",
      generation: 1,
      questionSha256: "c3cdd28ea02541b1c26e6af63ee415b252d2ccc32361e83d4df0bcc1e91b0f21",
      questionCount: 1,
      requestedAt: "2026-01-01T00:00:00.000Z",
      marker:
        "<!-- factory-decision:11111111-1111-4111-8111-111111111111:1:c3cdd28ea02541b1c26e6af63ee415b252d2ccc32361e83d4df0bcc1e91b0f21 -->",
    },
  );
  const rawCreateBody = created.calls[1]?.init?.body;
  if (typeof rawCreateBody !== "string") assert.fail("expected decision comment request body");
  const createBody = JSON.parse(rawCreateBody) as {
    variables: { input: { body: string } };
  };
  assert.match(createBody.variables.input.body, /profiles\/santiago/);
  assert.match(createBody.variables.input.body, /Decision:\n1\. <answer>/);
  assert.match(createBody.variables.input.body, /paused this run/);
  assert.match(createBody.variables.input.body, /factory-decision:/);

  const replies = sequence([
    {
      body: {
        data: {
          comment: {
            id: "comment-1",
            issue: { assignee: { id: "user-1" } },
            children: {
              nodes: [
                {
                  id: "reply-ignored",
                  body: "Decision: redirect",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  user: { id: "other-user" },
                },
                {
                  id: "reply-1",
                  body: "Decision: Keep the sign-in card",
                  createdAt: "2026-01-02T00:00:00.000Z",
                  user: { id: "user-1" },
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    },
  ]);
  const reply = await fetchLinearDecisionReply({
    fetch: replies.fetch,
    token: "secret",
    commentId: "comment-1",
  });
  assert.equal(reply?.commentId, "reply-1");
  assert.equal(reply?.body, "Keep the sign-in card");
  assert.match(reply?.sha256 ?? "", /^[0-9a-f]{64}$/);
});

test("Linear decision reply pins request identity and paginates", async () => {
  const request = {
    commentId: "comment-1",
    commentUrl: "https://linear.app/example/comment-1",
    issueId: "issue-1",
    assigneeId: "user-1",
    generation: 1,
    questionSha256: "c3cdd28ea02541b1c26e6af63ee415b252d2ccc32361e83d4df0bcc1e91b0f21",
    questionCount: 1,
    requestedAt: "2026-01-01T00:00:00.000Z",
    marker:
      "<!-- factory-decision:11111111-1111-4111-8111-111111111111:1:c3cdd28ea02541b1c26e6af63ee415b252d2ccc32361e83d4df0bcc1e91b0f21 -->",
  };
  const page = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null) => ({
    data: {
      comment: {
        id: "comment-1",
        body: request.marker,
        issue: { id: "issue-1", assignee: { id: "other-user" } },
        children: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  });
  const replies = sequence([
    {
      body: page(
        [
          {
            id: "stale",
            body: "Decision:\n1. old",
            createdAt: "2025-12-31T00:00:00.000Z",
            user: { id: "user-1" },
          },
          {
            id: "wrong",
            body: "Decision:\n1. wrong",
            createdAt: "2026-01-02T00:00:00.000Z",
            user: { id: "other-user" },
          },
        ],
        true,
        "cursor-1",
      ),
    },
    {
      body: page(
        [
          {
            id: "first",
            body: "Decision:\n1. first",
            createdAt: "2026-01-02T00:00:00.000Z",
            user: { id: "user-1" },
          },
          {
            id: "last",
            body: "Decision:\n1. last",
            createdAt: "2026-01-03T00:00:00.000Z",
            user: { id: "user-1" },
          },
          {
            id: "bad",
            body: "Decision: unnumbered",
            createdAt: "2026-01-04T00:00:00.000Z",
            user: { id: "user-1" },
          },
        ],
        false,
        null,
      ),
    },
  ]);
  const reply = await fetchLinearDecisionReply({ fetch: replies.fetch, token: "secret", request });
  assert.equal(reply?.commentId, "last");
  assert.equal(reply?.body, "1. last");
  assert.equal(replies.calls.length, 2);
  const rawSecond = replies.calls[1]?.init?.body;
  if (typeof rawSecond !== "string") assert.fail("expected pagination request body");
  const second = JSON.parse(rawSecond) as { variables: { after: string } };
  assert.equal(second.variables.after, "cursor-1");
});

test("Linear transport failures never expose token", async () => {
  const token = "linear-super-secret";
  await assert.rejects(
    () =>
      fetchLinearIssue({
        fetch: sequence([{ error: new Error(token) }]).fetch,
        token,
        issue: "RIFF-39",
      }),
    (error) =>
      error instanceof Error &&
      error.message === "Linear request failed" &&
      !error.message.includes(token),
  );
});

test("GitHub resolves canonical repository and exact commit ref", async () => {
  const fake = sequence([{ body: repository }, { body: reference }]);
  const snapshot = await fetchGitHubSnapshot({
    fetch: fake.fetch,
    token: "github-secret",
    owner: "Santychuy",
    repo: "bookbounce",
    baseRef: "main",
  });
  assert.equal(snapshot.fullName, "santychuy/bookbounce");
  assert.equal(snapshot.baseSha, "a".repeat(40));
  assert.equal(fake.calls.length, 2);
  assert.match(fake.calls[1]?.url ?? "", /git\/ref\/heads%2Fmain$/);
  assert.equal(
    new Headers(fake.calls[0]?.init?.headers).get("Authorization"),
    "Bearer github-secret",
  );
});

test("GitHub rejects invalid input, mismatches, bad refs, and API errors", async () => {
  const unused = sequence([]);
  await assert.rejects(
    () =>
      fetchGitHubSnapshot({
        fetch: unused.fetch,
        token: "x",
        owner: "bad/owner",
        repo: "x",
        baseRef: "main",
      }),
    /invalid GitHub repository/,
  );
  await assert.rejects(
    () =>
      fetchGitHubSnapshot({
        fetch: unused.fetch,
        token: "x",
        owner: "owner",
        repo: "repo",
        baseRef: "feature..x",
      }),
    /invalid GitHub base ref/,
  );
  assert.equal(unused.calls.length, 0);

  await assert.rejects(
    () =>
      fetchGitHubSnapshot({
        fetch: sequence([{ body: { ...repository, full_name: "someone/else" } }]).fetch,
        token: "x",
        owner: "santychuy",
        repo: "bookbounce",
        baseRef: "main",
      }),
    /repository mismatch/,
  );
  await assert.rejects(
    () =>
      fetchGitHubSnapshot({
        fetch: sequence([
          { body: repository },
          { body: { ...reference, object: { type: "commit", sha: "bad" } } },
        ]).fetch,
        token: "x",
        owner: "santychuy",
        repo: "bookbounce",
        baseRef: "main",
      }),
    /not a commit SHA/,
  );
  await assert.rejects(
    () =>
      fetchGitHubSnapshot({
        fetch: sequence([{ body: {}, status: 403 }]).fetch,
        token: "x",
        owner: "santychuy",
        repo: "bookbounce",
        baseRef: "main",
      }),
    /HTTP request failed \(403\)/,
  );
});

test("GitHub transport failures never expose token", async () => {
  const token = "github-super-secret";
  await assert.rejects(
    () =>
      fetchGitHubSnapshot({
        fetch: sequence([{ error: new Error(token) }]).fetch,
        token,
        owner: "santychuy",
        repo: "bookbounce",
        baseRef: "main",
      }),
    (error) =>
      error instanceof Error &&
      error.message === "GitHub request failed" &&
      !error.message.includes(token),
  );
});

test("GitHub publication pushes one deterministic branch and opens a ready PR", async () => {
  const baseSha = "a".repeat(40);
  const commitSha = "c".repeat(40);
  const idempotencyKey = "d".repeat(64);
  const token = "github-publication-secret";
  const commands: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  let revision = 0;
  const fake = sequence([
    { body: {}, status: 404 },
    { body: [] },
    {
      body: {
        number: 42,
        html_url: "https://github.com/santychuy/bookbounce/pull/42",
        state: "open",
        draft: false,
        head: { sha: commitSha },
      },
      status: 201,
    },
  ]);
  const result = await publishGitHubPullRequest({
    fetch: fake.fetch,
    runGit: async (args, _cwd, env) => {
      commands.push({ args, env });
      if (args.includes("rev-parse")) return `${revision++ === 0 ? baseSha : commitSha}\n`;
      if (args.includes("show")) return "2026-01-01T00:00:00Z\n";
      return "";
    },
    token,
    owner: "santychuy",
    repo: "bookbounce",
    baseRef: "main",
    baseSha,
    runId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey,
    issueIdentifier: "RIFF-40",
    issueTitle: "Remove previous tab",
    issueUrl: "https://linear.app/example/issue/RIFF-40/remove-previous-tab",
    patchPath: "/tmp/change.patch",
    patchSha256: "e".repeat(64),
  });

  assert.deepEqual(result, {
    number: 42,
    url: "https://github.com/santychuy/bookbounce/pull/42",
    branch: `factory/riff-40-${idempotencyKey.slice(0, 12)}`,
    commitSha,
  });
  assert.equal(commands.filter((call) => call.args.includes("push")).length, 1);
  assert.equal(commands.filter((call) => call.args.includes("commit")).length, 1);
  assert.doesNotMatch(JSON.stringify(commands.map((call) => call.args)), new RegExp(token));
  assert.ok(commands.every((call) => call.env.FACTORY_GITHUB_TOKEN === token));
  const create = fake.calls.at(-1);
  assert.equal(create?.init?.method, "POST");
  const requestBody = create?.init?.body;
  if (typeof requestBody !== "string") assert.fail("expected pull request JSON body");
  const body = JSON.parse(requestBody) as Record<string, unknown>;
  assert.equal(body.draft, false);
  assert.equal(body.head, result.branch);
});

test("GitHub publication reuses matching branch and PR without pushing", async () => {
  const baseSha = "a".repeat(40);
  const commitSha = "c".repeat(40);
  const idempotencyKey = "d".repeat(64);
  const branch = `factory/riff-40-${idempotencyKey.slice(0, 12)}`;
  const fake = sequence([
    { body: { ref: `refs/heads/${branch}`, object: { sha: commitSha } } },
    {
      body: [
        {
          number: 42,
          html_url: "https://github.com/santychuy/bookbounce/pull/42",
          state: "open",
          draft: false,
          head: { sha: commitSha },
        },
      ],
    },
  ]);
  const commands: string[][] = [];
  let revision = 0;
  const result = await publishGitHubPullRequest({
    fetch: fake.fetch,
    runGit: async (args) => {
      commands.push(args);
      if (args.includes("rev-parse")) return `${revision++ === 0 ? baseSha : commitSha}\n`;
      if (args.includes("show")) return "2026-01-01T00:00:00Z\n";
      return "";
    },
    token: "secret",
    owner: "santychuy",
    repo: "bookbounce",
    baseRef: "main",
    baseSha,
    runId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey,
    issueIdentifier: "RIFF-40",
    issueTitle: "Remove previous tab",
    issueUrl: "https://linear.app/example/issue/RIFF-40/remove-previous-tab",
    patchPath: "/tmp/change.patch",
    patchSha256: "e".repeat(64),
  });
  assert.equal(result.number, 42);
  assert.equal(
    commands.some((args) => args.includes("push")),
    false,
  );
  assert.equal(fake.calls.length, 2);
});

test("intake composition is deterministic and contains no credentials", async () => {
  const make = () =>
    createIntake(
      {
        fetch: sequence([{ body: linearIssue() }]).fetch,
        token: "linear-secret",
        issue: "RIFF-39",
      },
      {
        fetch: sequence([{ body: repository }, { body: reference }]).fetch,
        token: "github-secret",
        owner: "santychuy",
        repo: "bookbounce",
        baseRef: "main",
      },
    );
  const first = await make();
  const second = await make();
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.equal(first.repository.baseRef, "main");
  const serialized = JSON.stringify(first);
  assert.ok(!serialized.includes("linear-secret"));
  assert.ok(!serialized.includes("github-secret"));
});
