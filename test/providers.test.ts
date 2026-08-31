import assert from "node:assert/strict";
import test from "node:test";
import {
  validateExecutionReference,
  validateSourceControlReference,
  validateWorkItemReference,
} from "../src/providers.js";
import { ExeExecutionProvider } from "../src/integrations/exe-provider.js";
import { GitHubSourceControlProvider } from "../src/integrations/github-provider.js";
import { LinearWorkItemProvider } from "../src/integrations/linear-provider.js";

const issue = (identifier: string) => ({
  uuid: `uuid-${identifier}`,
  identifier,
  title: "Title",
  description: "Body",
  url: `https://linear.app/a/issue/${identifier}`,
  assignee: { id: "user", name: "User", url: "https://linear.app/a" },
  team: { id: "team", name: "Engineering", key: "ENG" },
  state: { id: "todo", name: "Todo", type: "unstarted" },
  labels: [],
  snapshotSha256: "a".repeat(64),
});
test("provider references reject mismatches, unknown fields, and unsafe values", () => {
  assert.throws(() => validateWorkItemReference({ provider: "github", id: "ENG-1" }, "linear"));
  assert.throws(() =>
    validateWorkItemReference({ provider: "linear", id: "ENG-1", token: "x" }, "linear"),
  );
  assert.throws(() =>
    validateSourceControlReference(
      { provider: "github", repository: "o/r", baseRef: "main\n" },
      "github",
    ),
  );
  assert.throws(() =>
    validateExecutionReference({ provider: "exe.dev", credential: "x" }, "exe.dev"),
  );
});
test("one Linear provider handles sequential references and delegates decisions without leaking credentials", async () => {
  const token = "linear-secret";
  let requested: unknown;
  const provider = new LinearWorkItemProvider({
    token,
    fetchIssue: async ({ issue: id }) => issue(id),
    createDecisionComment: async (value) => {
      requested = value;
      return {
        commentId: "comment",
        commentUrl: "https://linear.app/comment",
        issueId: value.issueId,
        assigneeId: value.assigneeId,
        generation: 1,
        questionSha256: "b".repeat(64),
        questionCount: 1,
        requestedAt: "2026-01-01T00:00:00.000Z",
        marker: `<!-- maquila-decision:${value.runId}:1:${"b".repeat(64)} -->`,
      };
    },
    fetchDecisionReply: async ({ request }) =>
      request
        ? {
            commentId: request.commentId,
            body: "Decision: yes",
            createdAt: "2026-01-01T00:01:00.000Z",
            sha256: "c".repeat(64),
          }
        : undefined,
  });
  const first = await provider.fetchWorkItem({ provider: "linear", id: "ENG-1" });
  const second = await provider.fetchWorkItem({ provider: "linear", id: "ENG-2" });
  assert.equal(second.key, "ENG-2");
  const receipt = await provider.requestDecision(
    { provider: "linear", id: "ENG-1" },
    {
      workItem: first,
      principal: first.decisionPrincipal!,
      runId: "123e4567-e89b-12d3-a456-426614174000",
      decisions: ["Choose"],
    },
  );
  assert.equal((requested as { issueId: string }).issueId, "uuid-ENG-1");
  assert.equal(
    (await provider.waitForDecision({ provider: "linear", id: "ENG-1" }, receipt))?.body,
    "Decision: yes",
  );
  assert.equal(JSON.stringify({ first, second, receipt }).includes(token), false);
});
test("GitHub provider handles references and delegates clone, dry-run, and publication", async () => {
  let dry: unknown;
  let published: unknown;
  const provider = new GitHubSourceControlProvider({
    token: "github-secret",
    fetchSnapshot: async ({ owner, repo, baseRef }) => ({
      repositoryId: 1,
      fullName: `${owner}/${repo}`,
      baseRef,
      baseSha: "b".repeat(40),
      private: true,
      defaultBranch: "main",
      snapshotSha256: "c".repeat(64),
    }),
    createPublicationDryRun: (value) => {
      dry = value;
      return {
        version: 1,
        mode: "dry-run",
        repository: `${value.owner}/${value.repo}`,
        baseRef: value.baseRef,
        baseSha: value.baseSha,
        runId: value.runId,
        idempotencyKey: value.idempotencyKey,
        issueIdentifier: value.issueIdentifier,
        proposedBranch: "bot",
        patchSha256: value.patchSha256,
      };
    },
    publishPullRequest: async (value) => {
      published = value;
      return {
        number: 4,
        url: "https://github.com/pr/4",
        branch: "bot",
        commitSha: "d".repeat(40),
      };
    },
  });
  const ref = { provider: "github", repository: "owner/repo", baseRef: "main" };
  const request = {
    runId: "123e4567-e89b-12d3-a456-426614174000",
    idempotencyKey: "k",
    issueIdentifier: "ENG-1",
    issueTitle: "Title",
    issueUrl: "https://linear.app/x",
    patchPath: "/safe.patch",
    patchSha256: "e".repeat(64),
    baseSha: "b".repeat(40),
  };
  assert.equal((await provider.fetchSourceControl(ref)).repository, "owner/repo");
  assert.equal(
    provider.cloneUrl(ref, await provider.fetchSourceControl(ref)),
    "https://github.int.exe.xyz/owner/repo.git",
  );
  assert.equal(provider.dryRunPublication(ref, request).mode, "dry-run");
  assert.equal((await provider.publishReviewedPatch(ref, request)).number, 4);
  assert.equal((dry as { token: string }).token, "github-secret");
  assert.equal((published as { token: string }).token, "github-secret");
});
test("exe provider validates each execution reference before delegation", async () => {
  const calls: string[] = [];
  const client = {
    createVm: async () => {
      calls.push("create");
      return { vmName: "vm", status: "ready", sshDest: "user@host" };
    },
    destroyVm: async () => ({ destroyed: true, notFound: false }),
    exec: async () => ({ stdout: "", stderr: "" }),
    execStream: async () => ({ stderr: "" }),
    copyTo: async () => ({ stdout: "", stderr: "" }),
    copyFrom: async () => ({ stdout: "", stderr: "" }),
  };
  const provider = new ExeExecutionProvider({ client });
  await assert.rejects(
    provider.createVm({ provider: "other" }, { name: "vm", tag: "tag" }),
    /mismatch/,
  );
  await provider.createVm({ provider: "exe.dev" }, { name: "vm", tag: "tag" });
  assert.deepEqual(calls, ["create"]);
});
