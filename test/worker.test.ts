import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Envelope } from "../src/envelope.js";
import type { AgentRunResult, RunAgentOptions, RunReceipt } from "../src/run-agent.js";
import type { VerificationResult, VerifyOptions } from "../src/verify.js";
import { runWorkerLifecycle } from "../src/workflows/worker.js";
import type { RemoteEvent } from "../src/remote-protocol.js";

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
  error?: string;
  mutate?: () => void | Promise<void>;
}

function agentStub(
  responses: StubResponse[],
  calls: RunAgentOptions[],
  documenterResponse?: StubResponse,
): typeof import("../src/run-agent.js").runAgent {
  return async (runOptions) => {
    calls.push(runOptions);
    const response =
      runOptions.agent.name === "documenter"
        ? (documenterResponse ?? {
            status: "completed" as const,
            envelope: {
              outcome: "no_change" as const,
              changedFiles: [],
              detail: "No documentation changes needed",
            },
          })
        : responses.shift();
    if (!response) throw new Error("unexpected agent call");
    await response.mutate?.();
    const receipt: RunReceipt = {
      runId: runOptions.artifacts.runId,
      status: response.status,
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      model: runOptions.agent.model,
      timeoutSeconds: runOptions.timeoutSeconds,
      agent: {
        name: runOptions.agent.name,
        description: runOptions.agent.description,
        tools: runOptions.agent.tools,
        thinking: runOptions.agent.thinking,
        access: runOptions.agent.access,
      },
      artifacts: ["issue.md", "events.jsonl", "receipt.json"],
      ...(response.error ? { error: response.error } : {}),
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
    assert.equal(calls.length, 2);
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
  const events: RemoteEvent[] = [];
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
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.status, "completed");
    assert.equal(verifyOptions?.commandTimeoutMs, 60_000);
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.agent.model, "openrouter/openai/gpt-5.6-terra");
    assert.equal(calls[1]?.agent.model, "openrouter/openai/gpt-5.6-terra");
    assert.equal(calls[2]?.agent.model, "openrouter/openai/gpt-5.6-terra");
    assert.notEqual(calls[0]?.artifacts.runDir, calls[2]?.artifacts.runDir);
    assert.match(calls[2]?.prompt ?? "", /new file mode/);
    assert.match(calls[2]?.prompt ?? "", /export const x = 1/);
    const lifecycle = await json(join(result.runDir, "lifecycle.json"));
    assert.equal(lifecycle.reviewerRunDir, result.reviewerRunDir);
    assert.ok(result.reviewerRunDir);
    assert.deepEqual(
      events.filter((event) => event.type === "phase_started").map((event) => event.phase),
      ["implementing", "documenting", "verifying", "reviewing"],
    );
    assert.ok(events.some((event) => event.type === "gate_finished" && event.passed));
    assert.ok(events.some((event) => event.type === "review_finished" && event.verdict === "PASS"));
    await readFile(join(result.reviewerRunDir, "lifecycle.json"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("review digest matches one staged diff for mixed tracked and untracked changes", async () => {
  const f = await fixture();
  const calls: RunAgentOptions[] = [];
  try {
    await mkdir(join(f.repo, "src"), { recursive: true });
    await writeFile(join(f.repo, "src", "z.ts"), "export const z = 0;\n");
    git(f.repo, "add", ".");
    git(f.repo, "commit", "-qm", "tracked source");
    f.baseSha = git(f.repo, "rev-parse", "HEAD");
    await writeFile(
      f.envelope,
      JSON.stringify({
        ...planner,
        changes: [
          { path: "src/z.ts", action: "modify", rationale: "Update tracked source" },
          { path: "src/a.ts", action: "add", rationale: "Add source" },
        ],
      }),
    );
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: agentStub(
        [
          {
            status: "completed",
            envelope: {
              ...workerEnvelope,
              changedFiles: ["src/z.ts", "src/a.ts"],
            },
            mutate: async () => {
              await writeFile(join(f.repo, "src", "z.ts"), "export const z = 1;\n");
              await writeFile(join(f.repo, "src", "a.ts"), "export const a = 1;\n");
            },
          },
          { status: "completed", envelope: reviewerPass },
        ],
        calls,
      ),
      verifyRepository: async () => verification(true, { changedPaths: ["src/a.ts", "src/z.ts"] }),
    });
    assert.equal(result.status, "completed");
    const reviewed = (await readFile(join(result.runDir, "review-diff.sha256"), "utf8")).trim();
    const staged = execFileSync("git", ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD"], {
      cwd: f.repo,
    });
    assert.equal(reviewed, createHash("sha256").update(staged).digest("hex"));
    const prompt = calls[2]?.prompt ?? "";
    assert.ok(prompt.indexOf("a/src/a.ts") < prompt.indexOf("a/src/z.ts"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("docs-only plan skips worker and runs documenter before review", async () => {
  const f = await fixture();
  const calls: RunAgentOptions[] = [];
  try {
    await writeFile(
      f.envelope,
      JSON.stringify({
        ...planner,
        changes: [{ path: "docs/a.md", action: "add", rationale: "Document behavior" }],
      }),
    );
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: agentStub([{ status: "completed", envelope: reviewerPass }], calls, {
        status: "completed",
        envelope: {
          outcome: "updated",
          changedFiles: ["docs/a.md"],
          detail: "Documented behavior",
        },
        mutate: async () => {
          await mkdir(join(f.repo, "docs"), { recursive: true });
          await writeFile(join(f.repo, "docs", "a.md"), "Documented\n");
        },
      }),
      verifyRepository: async () => verification(true, { changedPaths: ["docs/a.md"] }),
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(
      calls.map((call) => call.agent.name),
      ["documenter", "reviewer"],
    );
    assert.ok(await readFile(join(result.runDir, "lifecycle.json")));
    assert.ok(await readFile(join(result.runDir, "verification.json")));
    assert.ok(await readFile(join(result.runDir, "review-diff.sha256")));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("documenter timeout stays timed_out and closes documenting once", async () => {
  const f = await fixture();
  const events: RemoteEvent[] = [];
  try {
    await writeFile(
      f.envelope,
      JSON.stringify({
        ...planner,
        changes: [{ path: "docs/a.md", action: "add", rationale: "Document behavior" }],
      }),
    );
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: agentStub([], [], { status: "timed_out" }),
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.status, "timed_out");
    assert.deepEqual(
      events
        .filter(
          (event): event is Extract<RemoteEvent, { type: "phase_finished" }> =>
            event.type === "phase_finished" && event.phase === "documenting",
        )
        .map((event) => event.status),
      ["timed_out"],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("blocked documenter fails and closes documenting once", async () => {
  const f = await fixture();
  const events: RemoteEvent[] = [];
  try {
    await writeFile(
      f.envelope,
      JSON.stringify({
        ...planner,
        changes: [{ path: "docs/a.md", action: "add", rationale: "Document behavior" }],
      }),
    );
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: agentStub([], [], {
        status: "completed",
        envelope: {
          outcome: "blocked",
          changedFiles: [],
          detail: "Missing product decision",
        },
      }),
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.status, "failed");
    assert.equal((await json(join(result.runDir, "lifecycle.json"))).stage, "documenter");
    assert.deepEqual(
      events
        .filter(
          (event): event is Extract<RemoteEvent, { type: "phase_finished" }> =>
            event.type === "phase_finished" && event.phase === "documenting",
        )
        .map((event) => event.status),
      ["failed"],
    );
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

test("failed reviewer preserves receipt error in lifecycle", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.repo, "src"), { recursive: true });
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: agentStub(
        [
          {
            status: "completed",
            envelope: workerEnvelope,
            mutate: () => writeFile(join(f.repo, "src", "x.ts"), "x\n"),
          },
          { status: "failed", error: "reviewer envelope missing after correction" },
        ],
        [],
      ),
      verifyRepository: async () => verification(true),
    });
    assert.equal(result.status, "failed");
    assert.equal(
      (await json(join(result.runDir, "lifecycle.json"))).error,
      "reviewer envelope missing after correction",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("worker and reviewer timeouts remain timed out", async () => {
  const workerFixture = await fixture();
  const reviewerFixture = await fixture();
  try {
    const workerEvents: RemoteEvent[] = [];
    const workerTimeout = await runWorkerLifecycle({
      ...options(workerFixture),
      runAgent: agentStub([{ status: "timed_out" }], []),
      onEvent: (event) => workerEvents.push(event),
    });
    assert.equal(workerTimeout.status, "timed_out");
    assert.deepEqual(
      workerEvents.filter((event) => event.type === "phase_finished").map((event) => event.phase),
      ["implementing"],
    );

    await mkdir(join(reviewerFixture.repo, "src"), { recursive: true });
    const reviewerEvents: RemoteEvent[] = [];
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
      onEvent: (event) => reviewerEvents.push(event),
    });
    assert.equal(reviewerTimeout.status, "timed_out");
    assert.deepEqual(
      reviewerEvents
        .filter((event) => event.type === "phase_finished")
        .map((event) => [event.phase, event.status]),
      [
        ["implementing", "completed"],
        ["documenting", "completed"],
        ["verifying", "completed"],
        ["reviewing", "timed_out"],
      ],
    );
  } finally {
    await rm(workerFixture.root, { recursive: true, force: true });
    await rm(reviewerFixture.root, { recursive: true, force: true });
  }
});

test("reviewer exception closes the phase once", async () => {
  const f = await fixture();
  const events: RemoteEvent[] = [];
  const calls: RunAgentOptions[] = [];
  const workerRun = agentStub(
    [
      {
        status: "completed",
        envelope: workerEnvelope,
        mutate: async () => {
          await mkdir(join(f.repo, "src"), { recursive: true });
          await writeFile(join(f.repo, "src", "x.ts"), "x\n");
        },
      },
    ],
    calls,
  );
  try {
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: async (runOptions) => {
        if (runOptions.agent.name === "reviewer") throw new Error("reviewer unavailable");
        return workerRun(runOptions);
      },
      verifyRepository: async () => verification(true),
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(
      events
        .filter((event) => event.type === "phase_finished")
        .map((event) => [event.phase, event.status]),
      [
        ["implementing", "completed"],
        ["documenting", "completed"],
        ["verifying", "completed"],
        ["reviewing", "failed"],
      ],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("verification exception closes the phase once", async () => {
  const f = await fixture();
  const events: RemoteEvent[] = [];
  try {
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: agentStub([{ status: "completed", envelope: workerEnvelope }], []),
      verifyRepository: async () => {
        throw new Error("verification unavailable");
      },
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(
      events
        .filter((event) => event.type === "phase_finished")
        .map((event) => [event.phase, event.status]),
      [
        ["implementing", "completed"],
        ["documenting", "completed"],
        ["verifying", "failed"],
      ],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
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

test("worker rejects untracked documentation changes", async () => {
  const f = await fixture();
  const events: RemoteEvent[] = [];
  try {
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: agentStub(
        [
          {
            status: "completed",
            envelope: workerEnvelope,
            mutate: async () => {
              await mkdir(join(f.repo, "docs"), { recursive: true });
              await writeFile(join(f.repo, "docs", "leak.md"), "leak\n");
            },
          },
        ],
        [],
      ),
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.status, "failed");
    assert.equal((await json(join(result.runDir, "lifecycle.json"))).stage, "worker");
    assert.deepEqual(
      events
        .filter(
          (event): event is Extract<RemoteEvent, { type: "phase_finished" }> =>
            event.type === "phase_finished" && event.phase === "implementing",
        )
        .map((event) => event.status),
      ["failed"],
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("documenter cannot alter worker-owned content and closes its phase failed", async () => {
  const f = await fixture();
  const events: RemoteEvent[] = [];
  try {
    await mkdir(join(f.repo, "src"), { recursive: true });
    const result = await runWorkerLifecycle({
      ...options(f),
      runAgent: agentStub(
        [
          {
            status: "completed",
            envelope: workerEnvelope,
            mutate: () => writeFile(join(f.repo, "src", "x.ts"), "worker\n"),
          },
        ],
        [],
        {
          status: "completed",
          envelope: { outcome: "no_change", changedFiles: [], detail: "No docs" },
          mutate: () => writeFile(join(f.repo, "src", "x.ts"), "documenter\n"),
        },
      ),
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(
      events
        .filter(
          (event): event is Extract<RemoteEvent, { type: "phase_finished" }> =>
            event.type === "phase_finished" && event.phase === "documenting",
        )
        .map((event) => event.status),
      ["failed"],
    );
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
