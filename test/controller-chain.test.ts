import assert from "node:assert/strict";
import { test } from "node:test";
import { runControllerChain, waitForLinearDecision } from "../src/controller-chain.js";
import type { ControllerOptions, ControllerResult } from "../src/controller.js";

const firstRun = "11111111-1111-4111-8111-111111111111";
const secondRun = "22222222-2222-4222-8222-222222222222";
const decision = {
  commentId: "reply-1",
  body: "Keep the sign-in card",
  createdAt: "2026-01-02T00:00:00.000Z",
  sha256: "a".repeat(64),
};

function options(): ControllerOptions {
  return {
    issue: "RIFF-45",
    owner: "santychuy",
    repo: "bookbounce",
    baseRef: "main",
    tag: "santychuy-bookbounce",
    timeoutSeconds: 900,
    linearToken: "linear-token",
    githubToken: "github-token",
    openRouterKey: "openrouter-token",
    runId: firstRun,
  };
}

test("decision polling waits for an assigned Decision reply", async () => {
  let polls = 0;
  let sleeps = 0;
  const result = await waitForLinearDecision({
    token: "linear-token",
    commentId: "comment-1",
    intervalMilliseconds: 1,
    fetchDecision: async () => {
      polls += 1;
      if (polls === 1) throw new Error("temporary Linear failure");
      return polls === 2 ? undefined : decision;
    },
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.deepEqual(result, decision);
  assert.equal(polls, 3);
  assert.equal(sleeps, 2);
});

test("controller chain starts a fresh linked run with decision context", async () => {
  const calls: ControllerOptions[] = [];
  const results: ControllerResult[] = [
    {
      status: "awaiting_decision",
      runDir: `/tmp/${firstRun}`,
      decisionRequest: {
        runId: firstRun,
        commentId: "comment-1",
        commentUrl: "https://linear.app/example/comment-1",
        continuationRunId: secondRun,
        issue: "RIFF-45",
        owner: "santychuy",
        repo: "bookbounce",
        baseRef: "main",
        tag: "santychuy-bookbounce",
        timeoutSeconds: 900,
      },
    },
    { status: "completed", runDir: `/tmp/${secondRun}` },
  ];
  const result = await runControllerChain({
    ...options(),
    onAccepted: () => {},
    run: async (input) => {
      calls.push(input);
      return results.shift()!;
    },
    waitForDecision: async () => decision,
  });
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.runId, secondRun);
  assert.equal(calls[1]?.decision?.previousRunId, firstRun);
  assert.equal(calls[1]?.decision?.requestCommentId, "comment-1");
  assert.equal(calls[1]?.onAccepted, undefined);
});
