import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Envelope } from "../src/envelope.js";
import type { AgentRunResult, RunAgentOptions, RunReceipt } from "../src/run-agent.js";
import type { VerificationResult, VerifyOptions } from "../src/verify.js";
import { runWorkerLifecycle } from "../src/worker.js";

const planner = {
  summary: "Implement one file",
  evidence: ["Issue requests the change"],
  changes: [{ path: "src/x.ts", action: "add", rationale: "Implement behavior" }],
  verification: ["factory.verify.json"],
  risks: [],
  decisionsNeeded: [],
};

const workerEnvelope = {
  implemented: "Added src/x.ts",
  changedFiles: ["src/x.ts"],
  validation: [{ command: "test", outcome: "pass" as const, detail: "passed" }],
  openRisks: [],
};

const reviewerPass = {
  verdict: "PASS" as const,
  correct: ["Change matches plan"],
  blockingFindings: [],
  nonBlockingFindings: [],
  residualRisks: [],
};

const reviewerFail = {
  verdict: "FAIL" as const,
  correct: [],
  blockingFindings: ["Behavior is incorrect"],
  nonBlockingFindings: [],
  residualRisks: [],
};

interface Fixture {
  root: string;
  repo: string;
  issue: string;
  envelope: string;
  baseSha: string;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout: 10_000 }).trim();
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "factory-worker-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  const issue = join(root, "issue.md");
  const envelope = join(root, "planner.json");
  await writeFile(join(repo, "factory.verify.json"), '{"commands":[["true"]]}\n');
  await writeFile(issue, "Do change\n");
  await writeFile(envelope, JSON.stringify(planner));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  return { root, repo, issue, envelope, baseSha: git(repo, "rev-parse", "HEAD") };
}

interface StubResponse {
  status: AgentRunResult["status"];
  envelope?: Envelope;
  mutate?: () => void | Promise<void>;
}

function agentStub(
  responses: StubResponse[],
  calls: RunAgentOptions[],
): typeof import("../src/run-agent.js").runAgent {
  return async (runOptions) => {
    calls.push(runOptions);
    const response = responses.shift();
    if (!response) throw new Error("unexpected agent call");
    await response.mutate?.();
    const receipt: RunReceipt = {
      runId: runOptions.artifacts.runId,
      status: response.status,
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      model: runOptions.model,
      timeoutSeconds: runOptions.timeoutSeconds,
      agent: {
        name: runOptions.agent.name,
        description: runOptions.agent.description,
        tools: runOptions.agent.tools,
        thinking: runOptions.agent.thinking,
        access: runOptions.agent.access,
      },
      artifacts: ["issue.md", "events.jsonl", "receipt.json"],
    };
    runOptions.artifacts.writeJson("receipt.json", receipt);
    return {
      status: response.status,
      runDir: runOptions.artifacts.runDir,
      finalText: "",
      ...(response.envelope ? { envelope: response.envelope } : {}),
      receipt,
    };
  };
}

function verification(
  passed: boolean,
  overrides: { timedOut?: boolean; changedPaths?: string[] } = {},
): VerificationResult {
  const timedOut = overrides.timedOut ?? false;
  return {
    passed,
    config: { commands: [["true"]] },
    commands: [
      {
        argv: ["true"],
        exitCode: timedOut ? null : passed ? 0 : 1,
        timedOut,
        stdout: "",
        stderr: "",
        durationMs: 1,
      },
    ],
    git: {
      passed,
      baseSha: "0".repeat(40),
      headSha: "0".repeat(40),
      changedPaths: overrides.changedPaths ?? ["src/x.ts"],
      unexpectedPaths: [],
      reason: passed ? null : "failed",
    },
  };
}

function options(f: Fixture) {
  return {
    repo: f.repo,
    issue: f.issue,
    plannerEnvelope: f.envelope,
    baseSha: f.baseSha,
    model: "test/model",
    timeoutSeconds: 60,
    root: f.root,
  };
}

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("dirty baseline invokes no agent and writes lifecycle receipt", async () => {
  const f = await fixture();
  const calls: RunAgentOptions[] = [];
  try {
    await writeFile(join(f.repo, "dirty.txt"), "dirty\n");
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: agentStub([], calls),
    });
    assert.equal(result.status, "failed");
    assert.equal(calls.length, 0);
    assert.equal((await json(join(result.runDir, "lifecycle.json"))).stage, "baseline");
    const receipt = await json(join(result.runDir, "receipt.json"));
    assert.ok((receipt.artifacts as string[]).includes("lifecycle.json"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("blocked planner invokes no agent and preserves evidence", async () => {
  const f = await fixture();
  const calls: RunAgentOptions[] = [];
  try {
    await writeFile(f.envelope, JSON.stringify({ ...planner, decisionsNeeded: ["Need choice"] }));
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: agentStub([], calls),
    });
    assert.equal(result.status, "failed");
    assert.equal(calls.length, 0);
    assert.equal((await json(join(result.runDir, "lifecycle.json"))).stage, "planner");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("verification failure blocks reviewer and indexes evidence", async () => {
  const f = await fixture();
  const calls: RunAgentOptions[] = [];
  try {
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: agentStub([{ status: "completed", envelope: workerEnvelope }], calls),
      verifyRepository: async () => verification(false),
    });
    assert.equal(result.status, "failed");
    assert.equal(calls.length, 1);
    assert.equal((await json(join(result.runDir, "lifecycle.json"))).stage, "verification");
    const receipt = await json(join(result.runDir, "receipt.json"));
    assert.deepEqual(
      (receipt.artifacts as string[]).filter((name) => name.endsWith(".json")).toSorted(),
      ["lifecycle.json", "receipt.json", "verification.json"],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("successful worker invokes separate reviewer with untracked patch", async () => {
  const f = await fixture();
  const calls: RunAgentOptions[] = [];
  let verifyOptions: VerifyOptions | undefined;
  try {
    const run = agentStub(
      [
        {
          status: "completed",
          envelope: workerEnvelope,
          mutate: () => writeFile(join(f.repo, "src", "x.ts"), "export const x = 1;\n"),
        },
        { status: "completed", envelope: reviewerPass },
      ],
      calls,
    );
    await mkdir(join(f.repo, "src"), { recursive: true });
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: run,
      verifyRepository: async (received) => {
        verifyOptions = received;
        return verification(true);
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(verifyOptions?.commandTimeoutMs, 60_000);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0]?.artifacts.runDir, calls[1]?.artifacts.runDir);
    assert.match(calls[1]?.prompt ?? "", /new file mode/);
    assert.match(calls[1]?.prompt ?? "", /export const x = 1/);
    const lifecycle = await json(join(result.runDir, "lifecycle.json"));
    assert.equal(lifecycle.reviewerRunDir, result.reviewerRunDir);
    assert.ok(result.reviewerRunDir);
    await readFile(join(result.reviewerRunDir, "lifecycle.json"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("reviewer FAIL fails lifecycle", async () => {
  const f = await fixture();
  const calls: RunAgentOptions[] = [];
  try {
    await mkdir(join(f.repo, "src"), { recursive: true });
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: agentStub(
        [
          {
            status: "completed",
            envelope: workerEnvelope,
            mutate: () => writeFile(join(f.repo, "src", "x.ts"), "bad\n"),
          },
          { status: "completed", envelope: reviewerFail },
        ],
        calls,
      ),
      verifyRepository: async () => verification(true),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.reviewer?.verdict, "FAIL");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("worker and reviewer timeouts remain timed out", async () => {
  const workerFixture = await fixture();
  const reviewerFixture = await fixture();
  try {
    const workerTimeout = await runWorkerLifecycle({
      ...options(workerFixture),
      runAgent: agentStub([{ status: "timed_out" }], []),
    });
    assert.equal(workerTimeout.status, "timed_out");

    await mkdir(join(reviewerFixture.repo, "src"), { recursive: true });
    const reviewerTimeout = await runWorkerLifecycle({
      ...options(reviewerFixture),
      runAgent: agentStub(
        [
          {
            status: "completed",
            envelope: workerEnvelope,
            mutate: () => writeFile(join(reviewerFixture.repo, "src", "x.ts"), "x\n"),
          },
          { status: "timed_out" },
        ],
        [],
      ),
      verifyRepository: async () => verification(true),
    });
    assert.equal(reviewerTimeout.status, "timed_out");
  } finally {
    await rm(workerFixture.root, { recursive: true, force: true });
    await rm(reviewerFixture.root, { recursive: true, force: true });
  }
});

test("verification timeout returns timed_out", async () => {
  const f = await fixture();
  try {
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: agentStub([{ status: "completed", envelope: workerEnvelope }], []),
      verifyRepository: async () => verification(false, { timedOut: true }),
    });
    assert.equal(result.status, "timed_out");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("direct lifecycle options reject invalid timeout", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => runWorkerLifecycle({ ...options(f), timeoutSeconds: 0 }),
      /1 to 1800/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
