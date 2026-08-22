import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "../src/agents/index.js";
import {
  agentFailureCode,
  assistantFailureMessage,
  cappedAgentOutputTokens,
  openControllerSession,
  runAgent,
  runArtifactNameErrors,
  tokenUsageActivity,
} from "../src/run-agent.js";
import { createRunArtifacts } from "../src/run-artifacts.js";

test("token usage activity copies finalized session token totals", () => {
  const tokens = { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, total: 17 };
  assert.deepEqual(tokenUsageActivity(tokens, "2026-01-01T00:00:00.000Z", 0.000_001_234), {
    type: "agent_usage",
    at: "2026-01-01T00:00:00.000Z",
    tokens,
    reportedCostNanoUsd: 1234,
  });
  assert.equal(tokenUsageActivity(tokens, undefined, Number.NaN).reportedCostNanoUsd, undefined);
});

test("agent output tokens are capped to a bounded maquila budget", () => {
  assert.equal(cappedAgentOutputTokens(128_000), 16_384);
  assert.equal(cappedAgentOutputTokens(8_192), 8_192);
});

test("controller session reopening accepts only pinned artifact sessions", () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-session-"));
  const sessions = resolve(root, "sessions");
  try {
    mkdirSync(sessions);
    const path = resolve(sessions, "planner.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: root,
      })}\n`,
    );
    const checkpoint = {
      path,
      sessionId: "session-1",
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
    assert.equal(
      openControllerSession(checkpoint, sessions, root).getSessionId(),
      checkpoint.sessionId,
    );
    assert.throws(
      () => openControllerSession({ ...checkpoint, sha256: "0".repeat(64) }, sessions, root),
      /hash mismatch/,
    );
    assert.throws(
      () =>
        openControllerSession(
          { ...checkpoint, path: resolve(root, "outside.jsonl") },
          sessions,
          root,
        ),
      /outside artifacts/,
    );
    writeFileSync(path, "not jsonl");
    const corrupt = {
      ...checkpoint,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
    assert.throws(() => openControllerSession(corrupt, sessions, root), /invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent failures expose fixed public codes", () => {
  assert.equal(
    agentFailureCode({
      status: "failed",
      runDir: "/tmp/run",
      finalText: "",
      receipt: {
        runId: "run",
        status: "failed",
        startedAt: "2026-01-01T00:00:00.000Z",
        timeoutSeconds: 60,
        agent: {
          name: "planner",
          description: "planner",
          tools: [],
          thinking: "medium",
          access: "read-only",
        },
        artifacts: [],
        error: "Model request error: unavailable",
      },
    }),
    "model_request_failed",
  );
});

test("assistant provider failures are reported before envelope correction", () => {
  assert.equal(
    assistantFailureMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "No endpoints found for model",
    }),
    "Model request error: No endpoints found for model",
  );
  assert.equal(
    assistantFailureMessage({ role: "assistant", stopReason: "aborted" }),
    "Model request aborted",
  );
  assert.equal(assistantFailureMessage({ role: "assistant", stopReason: "toolUse" }), undefined);
});

const planner: AgentDefinition = {
  name: "planner",
  description: "Test planner",
  model: "bogus/not-a-model",
  tools: ["read", "grep", "find", "ls"],
  thinking: "medium",
  access: "read-only",
  systemPrompt: "You are a test planner.",
  filePath: "/tmp/planner.md",
};

test("runAgent finalizes a failed receipt without completion artifacts when the model is unknown", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-run-agent-"));
  try {
    const artifacts = createRunArtifacts("issue text", root);
    let completedCalls = 0;
    let deltas = 0;
    const result = await runAgent({
      agent: planner,
      cwd: root,
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
  const root = mkdtempSync(resolve(tmpdir(), "maquila-artifact-modes-"));
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
  const root = mkdtempSync(resolve(tmpdir(), "maquila-artifact-names-"));
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
