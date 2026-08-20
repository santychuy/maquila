import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "../src/agents/index.js";
import { runAgent, runArtifactNameErrors, tokenUsageActivity } from "../src/run-agent.js";
import { createRunArtifacts } from "../src/run-artifacts.js";

test("token usage activity copies finalized session token totals", () => {
  const tokens = { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, total: 17 };
  assert.deepEqual(tokenUsageActivity(tokens, "2026-01-01T00:00:00.000Z"), {
    type: "agent_usage",
    at: "2026-01-01T00:00:00.000Z",
    tokens,
  });
});

const planner: AgentDefinition = {
  name: "planner",
  description: "Test planner",
  tools: ["read", "grep", "find", "ls"],
  thinking: "medium",
  access: "read-only",
  systemPrompt: "You are a test planner.",
  filePath: "/tmp/planner.md",
};

test("runAgent finalizes a failed receipt without completion artifacts when the model is unknown", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-run-agent-"));
  try {
    const artifacts = createRunArtifacts("issue text", root);
    let completedCalls = 0;
    let deltas = 0;
    const result = await runAgent({
      agent: planner,
      cwd: root,
      model: "bogus/not-a-model",
      timeoutSeconds: 60,
      prompt: "Plan this issue.\n\nissue text",
      artifacts,
      receiptContext: {
        repo: root,
        baseSha: "deadbeef",
        repoWasDirty: false,
        issueSha256: "abc123",
      },
      onTextDelta: () => {
        deltas += 1;
      },
      onCompleted: () => {
        completedCalls += 1;
        return ["plan.md"];
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.runDir, artifacts.runDir);
    assert.equal(result.finalText, "");
    assert.equal(completedCalls, 0);
    assert.equal(deltas, 0);
    assert.ok(!existsSync(resolve(artifacts.runDir, "plan.md")));

    const receipt = JSON.parse(
      readFileSync(resolve(artifacts.runDir, "receipt.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(Object.keys(receipt), [
      "runId",
      "status",
      "startedAt",
      "repo",
      "baseSha",
      "repoWasDirty",
      "issueSha256",
      "model",
      "timeoutSeconds",
      "agent",
      "artifacts",
      "error",
      "finishedAt",
    ]);
    assert.equal(receipt.status, "failed");
    assert.match(receipt.error as string, /not found|Unknown model/);
    assert.equal(receipt.issueSha256, "abc123");
    assert.deepEqual(receipt.artifacts, ["issue.md", "events.jsonl", "receipt.json"]);
    assert.deepEqual(receipt.agent, {
      name: "planner",
      description: "Test planner",
      tools: ["read", "grep", "find", "ls"],
      thinking: "medium",
      access: "read-only",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run artifacts use private directory and file modes", () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-artifact-modes-"));
  try {
    const artifacts = createRunArtifacts("issue", root);
    artifacts.write("note.txt", "private");
    assert.equal(statSync(artifacts.runDir).mode & 0o777, 0o700);
    assert.equal(statSync(artifacts.sessionsDir).mode & 0o777, 0o700);
    for (const name of ["issue.md", "events.jsonl", "note.txt"])
      assert.equal(statSync(resolve(artifacts.runDir, name)).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runArtifactNameErrors accepts existing basenames and rejects unsafe or missing names", () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-artifact-names-"));
  try {
    writeFileSync(resolve(root, "plan.md"), "plan");
    assert.deepEqual(runArtifactNameErrors(["plan.md"], root), []);
    assert.deepEqual(runArtifactNameErrors([], root), []);

    const errors = runArtifactNameErrors(
      ["missing.md", "../receipt.json", "sub/plan.md", "..", ".", ""],
      root,
    );
    assert.equal(errors.length, 6);
    assert.match(errors[0] ?? "", /does not exist.*missing\.md/);
    for (const error of errors.slice(1)) assert.match(error, /unsafe artifact name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
