import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchGitHubSnapshot } from "../src/github.js";
import { createIntake } from "../src/intake.js";
import { fetchLinearIssue } from "../src/linear.js";

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
