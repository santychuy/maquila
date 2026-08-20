import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  harvest,
  recoverAbandonedAttempts,
  runController,
  type ControllerExe,
} from "../src/controller.js";
import { acquireControllerLock } from "../src/controller-lock.js";
import {
  createControllerState,
  readControllerState,
  transitionControllerState,
} from "../src/run-state.js";
import { createRemoteProtocolWriter, MAX_REMOTE_STREAM_BYTES } from "../src/remote-protocol.js";
import { createTelemetryWriter, readTelemetry, telemetryPath } from "../src/telemetry.js";

const ids = [
  "11111111-1111-1111-1111-111111111111",
  "22222222-2222-2222-2222-222222222222",
  "33333333-3333-3333-3333-333333333333",
];
const BASE_SHA = "a".repeat(40);
const PATCH = "diff --git a/docs/a.md b/docs/a.md\n";
const PATCH_SHA256 = createHash("sha256").update(PATCH).digest("hex");
let factoryRoot: string | undefined;
function testFactoryRoot(): string {
  if (factoryRoot) return factoryRoot;
  factoryRoot = mkdtempSync(join(tmpdir(), "factory-runtime-"));
  mkdirSync(join(factoryRoot, "src", "agents"), { recursive: true });
  for (const role of ["planner", "worker", "reviewer"]) {
    copyFileSync(
      join(process.cwd(), "src", "agents", `${role}.md`),
      join(factoryRoot, "src", "agents", `${role}.md`),
    );
  }
  execFileSync("git", ["init", "--quiet"], { cwd: factoryRoot });
  execFileSync("git", ["add", "src"], { cwd: factoryRoot });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "runtime",
    ],
    { cwd: factoryRoot },
  );
  return factoryRoot;
}
after(() => {
  if (factoryRoot) rmSync(factoryRoot, { recursive: true, force: true });
});

test("recovery terminalizes an accepted child that died before intake state", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-attempt-"));
  const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  try {
    const attempt = join(root, ".factory", "attempts", runId);
    mkdirSync(attempt, { recursive: true });
    writeFileSync(
      join(attempt, "recovery.json"),
      JSON.stringify({
        version: 1,
        runId,
        pid: 999_999,
        processIdentity: "dead:process",
        startedAt: new Date().toISOString(),
      }),
    );
    createTelemetryWriter(root, runId).append({
      type: "run_created",
      actor: "controller",
      payload: { status: "created" },
    });
    recoverAbandonedAttempts(root);
    const events = readTelemetry(telemetryPath(root, runId));
    assert.deepEqual(
      events.slice(-2).map((event) => event.type),
      ["failure", "run_finished"],
    );
    assert.equal(events.at(-1)?.type, "run_finished");
    assert.equal(existsSync(attempt), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
const HARVEST_EXPECTED = {
  baseSha: BASE_SHA,
  allowedPaths: ["docs/a.md"],
  patchSha256: PATCH_SHA256,
};
function file(root: string, run: string, name: string, value = "{}") {
  const path = join(root, ".factory", "runs", run, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, value);
}
function receipt(
  runId: string,
  role: "planner" | "worker" | "reviewer",
  artifacts: string[],
): string {
  return JSON.stringify({
    runId,
    status: "completed",
    baseSha: BASE_SHA,
    ...(role === "reviewer" ? { workerRunId: ids[1] } : {}),
    agent: { name: role },
    artifacts,
  });
}
function validArchive(root: string, unsafeLink = false, reviewDigest = PATCH_SHA256): string {
  const verification = {
    passed: true,
    config: { commands: [["bun", "run", "check"]] },
    commands: [
      {
        argv: ["bun", "run", "check"],
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        durationMs: 1,
      },
    ],
    git: {
      passed: true,
      baseSha: BASE_SHA,
      headSha: BASE_SHA,
      changedPaths: ["docs/a.md"],
      unexpectedPaths: [],
      reason: null,
    },
  };
  const lifecycle = {
    status: "completed",
    stage: "reviewer",
    baseSha: BASE_SHA,
    allowedPaths: ["docs/a.md"],
    workerRunId: ids[1],
    reviewerRunId: ids[2],
    workerRunDir: `/home/exedev/factory/.factory/runs/${ids[1]}`,
    reviewerRunDir: `/home/exedev/factory/.factory/runs/${ids[2]}`,
    reviewPatchSha256: reviewDigest,
    verification,
  };
  file(root, ids[0]!, "receipt.json", receipt(ids[0]!, "planner", ["envelope.json", "plan.md"]));
  file(
    root,
    ids[0]!,
    "envelope.json",
    JSON.stringify({
      summary: "Document architecture assessment",
      evidence: ["RIFF-39 requests documentation"],
      changes: [{ path: "docs/a.md", action: "add", rationale: "Document assessment" }],
      verification: ["Run bun run check"],
      risks: [],
      decisionsNeeded: [],
    }),
  );
  file(root, ids[0]!, "plan.md", "plan");
  file(
    root,
    ids[1]!,
    "receipt.json",
    receipt(ids[1]!, "worker", [
      "envelope.json",
      "lifecycle.json",
      "verification.json",
      "review-diff.sha256",
    ]),
  );
  file(
    root,
    ids[1]!,
    "envelope.json",
    JSON.stringify({
      implemented: ["Documented assessment"],
      changedFiles: ["docs/a.md"],
      validation: [{ command: "bun run check", outcome: "pass", detail: "passed" }],
      openRisks: [],
    }),
  );
  file(root, ids[1]!, "lifecycle.json", JSON.stringify(lifecycle));
  file(root, ids[1]!, "verification.json", JSON.stringify(verification));
  file(root, ids[1]!, "review-diff.sha256", `${reviewDigest}\n`);
  file(
    root,
    ids[2]!,
    "receipt.json",
    receipt(ids[2]!, "reviewer", ["envelope.json", "lifecycle.json"]),
  );
  file(root, ids[2]!, "lifecycle.json", JSON.stringify(lifecycle));
  file(
    root,
    ids[2]!,
    "envelope.json",
    JSON.stringify({
      verdict: "PASS",
      correct: ["Verification passed"],
      blockingFindings: [],
      nonBlockingFindings: [],
      residualRisks: [],
    }),
  );
  if (unsafeLink) symlinkSync("/tmp", join(root, ".factory", "runs", ids[0]!, "unsafe-link"));
  const archive = join(root, "evidence.tar");
  execFileSync("tar", ["-cf", archive, "-C", root, ".factory/runs"]);
  return archive;
}
test("harvest validates evidence requirements", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  try {
    harvest(validArchive(root), join(root, "out"), ids, HARVEST_EXPECTED);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("harvest rejects traversal run identifiers", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  try {
    assert.throws(
      () =>
        harvest(
          validArchive(root),
          join(root, "out"),
          ["../bad", ids[1]!, ids[2]!],
          HARVEST_EXPECTED,
        ),
      /unsafe remote run id/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("harvest rejects duplicate run identities and mismatched receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  try {
    const archive = validArchive(root);
    assert.throws(
      () =>
        harvest(archive, join(root, "duplicate"), [ids[0]!, ids[0]!, ids[2]!], HARVEST_EXPECTED),
      /distinct/,
    );
    file(root, ids[0]!, "receipt.json", receipt(ids[1]!, "planner", ["envelope.json", "plan.md"]));
    const mismatched = join(root, "mismatched.tar");
    execFileSync("tar", ["-cf", mismatched, "-C", root, ".factory/runs"]);
    assert.throws(
      () => harvest(mismatched, join(root, "mismatch"), ids, HARVEST_EXPECTED),
      /did not pass/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("harvest binds verification, role links, base SHA, and reviewed patch", () => {
  const cases: Array<{ name: string; mutate(root: string): void }> = [
    {
      name: "failed command",
      mutate(root) {
        const verification = JSON.parse(
          readFileSync(join(root, ".factory", "runs", ids[1]!, "verification.json"), "utf8"),
        ) as { commands: Array<{ exitCode: number }> };
        verification.commands[0]!.exitCode = 1;
        file(root, ids[1]!, "verification.json", JSON.stringify(verification));
      },
    },
    {
      name: "wrong base SHA",
      mutate(root) {
        const lifecycle = JSON.parse(
          readFileSync(join(root, ".factory", "runs", ids[1]!, "lifecycle.json"), "utf8"),
        ) as { baseSha: string };
        lifecycle.baseSha = "b".repeat(40);
        file(root, ids[1]!, "lifecycle.json", JSON.stringify(lifecycle));
      },
    },
    {
      name: "missing reviewer link",
      mutate(root) {
        const reviewerReceipt = JSON.parse(
          readFileSync(join(root, ".factory", "runs", ids[2]!, "receipt.json"), "utf8"),
        ) as Record<string, unknown>;
        delete reviewerReceipt.workerRunId;
        file(root, ids[2]!, "receipt.json", JSON.stringify(reviewerReceipt));
      },
    },
    {
      name: "missing artifact index",
      mutate(root) {
        const workerReceipt = JSON.parse(
          readFileSync(join(root, ".factory", "runs", ids[1]!, "receipt.json"), "utf8"),
        ) as { artifacts: string[] };
        workerReceipt.artifacts = workerReceipt.artifacts.filter(
          (name) => name !== "review-diff.sha256",
        );
        file(root, ids[1]!, "receipt.json", JSON.stringify(workerReceipt));
      },
    },
  ];
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
    try {
      validArchive(root);
      item.mutate(root);
      const archive = join(root, `${item.name.replaceAll(" ", "-")}.tar`);
      execFileSync("tar", ["-cf", archive, "-C", root, ".factory/runs"]);
      assert.throws(
        () => harvest(archive, join(root, "out"), ids, HARVEST_EXPECTED),
        /did not pass/,
        item.name,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("harvest rejects symbolic links", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  try {
    assert.throws(
      () => harvest(validArchive(root, true), join(root, "out"), ids, HARVEST_EXPECTED),
      /unsafe/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class FakeExe implements ControllerExe {
  readonly calls: Array<{ operation: string; value: unknown }> = [];

  constructor(
    private readonly failPlanner = false,
    private readonly failDestroy = false,
    private readonly malformedStream = false,
    private readonly invalidSequence = false,
    private readonly missingGate = false,
    private readonly failedPhaseProgression = false,
    private readonly streamBreakAfterStart = false,
    private readonly invalidToolActivity = false,
    private readonly mismatchedToolFinish = false,
    private readonly failCreateAfterSideEffect = false,
    private readonly failCopy = false,
    private readonly mismatchedReviewDigest = false,
    private readonly failedGateProgression = false,
    private readonly failedReviewProgression = false,
    private readonly normalFailedGate = false,
    private readonly normalFailedReview = false,
  ) {}

  async createVm(options: { name: string; tag: string }) {
    this.calls.push({ operation: "create", value: options });
    if (this.failCreateAfterSideEffect) throw new Error("create response lost after VM creation");
    return { vmName: options.name, status: "creating", sshDest: `${options.name}.exe.xyz` };
  }

  async execStream(
    destination: string,
    argv: string[],
    onStdout: (chunk: Buffer) => void,
    timeoutMs?: number,
  ) {
    this.calls.push({ operation: "execStream", value: { destination, argv, timeoutMs } });
    if (this.malformedStream) {
      onStdout(Buffer.from('{"protocol":1,"kind":"event"}\n'));
      return { stderr: "" };
    }
    if (this.streamBreakAfterStart) {
      const output: string[] = [];
      const protocol = createRemoteProtocolWriter((line) => output.push(line));
      protocol.event({
        type: "phase_started",
        actor: "planner",
        phase: "planning",
        sourceAt: new Date().toISOString(),
      });
      onStdout(Buffer.from(`${output.join("")}{malformed}\n`));
      return { stderr: "" };
    }
    const output: string[] = [];
    const protocol = createRemoteProtocolWriter((line) => output.push(line));
    const sourceAt = "1970-01-01T00:00:00.000+00:00";
    if (argv.includes("plan")) {
      if (this.invalidSequence)
        protocol.event({ type: "phase_started", actor: "worker", phase: "implementing", sourceAt });
      else protocol.event({ type: "phase_started", actor: "planner", phase: "planning", sourceAt });
      if (!this.invalidSequence) {
        protocol.event({ type: "agent_started", actor: "planner", phase: "planning", sourceAt });
        protocol.event({
          type: "tool_started",
          actor: "planner",
          phase: "planning",
          toolName: this.invalidToolActivity ? "bash" : "read",
          toolCallId: "remote-private-path-content",
          sourceAt,
        });
        protocol.event({
          type: "tool_finished",
          actor: "planner",
          phase: "planning",
          toolName: this.invalidToolActivity ? "bash" : "read",
          toolCallId: this.mismatchedToolFinish
            ? "different-remote-id"
            : "remote-private-path-content",
          isError: false,
          sourceAt,
        });
        protocol.event({
          type: "agent_finished",
          actor: "planner",
          phase: "planning",
          status: "completed",
          sourceAt,
        });
        protocol.event({
          type: "agent_usage",
          actor: "planner",
          phase: "planning",
          tokens: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, total: 14 },
          sourceAt,
        });
      }
      protocol.event({
        type: "phase_finished",
        actor: this.invalidSequence ? "worker" : "planner",
        phase: this.invalidSequence ? "implementing" : "planning",
        status: "completed",
        sourceAt,
      });
      protocol.result({
        status: this.failPlanner ? "failed" : "completed",
        runDir: `/home/exedev/factory/.factory/runs/${ids[0]}`,
      });
    } else {
      protocol.event({ type: "phase_started", actor: "worker", phase: "implementing", sourceAt });
      protocol.event({ type: "agent_started", actor: "worker", phase: "implementing", sourceAt });
      protocol.event({
        type: "agent_finished",
        actor: "worker",
        phase: "implementing",
        status: "completed",
        sourceAt,
      });
      protocol.event({
        type: "agent_usage",
        actor: "worker",
        phase: "implementing",
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        sourceAt,
      });
      if (this.failedPhaseProgression) {
        protocol.event({
          type: "phase_finished",
          actor: "worker",
          phase: "implementing",
          status: "failed",
          sourceAt,
        });
        protocol.event({ type: "phase_started", actor: "verifier", phase: "verifying", sourceAt });
        protocol.result({
          status: "failed",
          runDir: `/home/exedev/factory/.factory/runs/${ids[1]}`,
        });
        onStdout(Buffer.from(output.join("")));
        return { stderr: "" };
      }
      protocol.event({
        type: "phase_finished",
        actor: "worker",
        phase: "implementing",
        status: "completed",
        sourceAt,
      });
      protocol.event({ type: "phase_started", actor: "verifier", phase: "verifying", sourceAt });
      if (!this.missingGate)
        protocol.event({
          type: "gate_finished",
          actor: "verifier",
          phase: "verifying",
          passed: !this.failedGateProgression && !this.normalFailedGate,
          commandCount: 1,
          changedPathCount: 1,
          timedOut: false,
          sourceAt,
        });
      protocol.event({
        type: "phase_finished",
        actor: "verifier",
        phase: "verifying",
        status: this.normalFailedGate ? "failed" : "completed",
        sourceAt,
      });
      if (this.normalFailedGate) {
        protocol.result({
          status: "failed",
          runDir: `/home/exedev/factory/.factory/runs/${ids[1]}`,
        });
        onStdout(Buffer.from(output.join("")));
        return { stderr: "" };
      }
      protocol.event({ type: "phase_started", actor: "reviewer", phase: "reviewing", sourceAt });
      protocol.event({ type: "agent_started", actor: "reviewer", phase: "reviewing", sourceAt });
      protocol.event({
        type: "agent_finished",
        actor: "reviewer",
        phase: "reviewing",
        status: "completed",
        sourceAt,
      });
      protocol.event({
        type: "agent_usage",
        actor: "reviewer",
        phase: "reviewing",
        tokens: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, total: 5 },
        sourceAt,
      });
      protocol.event({
        type: "review_finished",
        actor: "reviewer",
        phase: "reviewing",
        verdict: this.failedReviewProgression || this.normalFailedReview ? "FAIL" : "PASS",
        blockerCount: this.failedReviewProgression || this.normalFailedReview ? 1 : 0,
        sourceAt,
      });
      protocol.event({
        type: "phase_finished",
        actor: "reviewer",
        phase: "reviewing",
        status: this.normalFailedReview ? "failed" : "completed",
        sourceAt,
      });
      protocol.result({
        status: this.normalFailedReview ? "failed" : "completed",
        runDir: `/home/exedev/factory/.factory/runs/${ids[1]}`,
        reviewerRunDir: `/home/exedev/factory/.factory/runs/${ids[2]}`,
      });
    }
    const framed = output.join("");
    for (let index = 0; index < framed.length; index += 17)
      onStdout(Buffer.from(framed.slice(index, index + 17)));
    return { stderr: "" };
  }

  async destroyVm(name: string) {
    this.calls.push({ operation: "destroy", value: name });
    if (this.failDestroy) throw new Error("destroy failed");
    return { destroyed: true, notFound: false };
  }

  async exec(destination: string, argv: string[], timeoutMs?: number) {
    this.calls.push({ operation: "exec", value: { destination, argv, timeoutMs } });
    if (argv[1] === "/home/exedev/capture.mjs") {
      const child: unknown = JSON.parse(argv[2]!);
      assert.ok(Array.isArray(child));
      const command = child.join(" ");
      const stdout = command.includes(" pi plan ")
        ? `\nRun evidence: /home/exedev/factory/.factory/runs/${ids[0]}\n`
        : `\nRun evidence: /home/exedev/factory/.factory/runs/${ids[1]}\nReviewer evidence: /home/exedev/factory/.factory/runs/${ids[2]}\n`;
      return {
        stdout: JSON.stringify({
          code: this.failPlanner && command.includes(" pi plan ") ? 1 : 0,
          signal: null,
          stdout,
          stderr: "",
        }),
        stderr: "",
      };
    }
    if (argv[0] === "uname") return { stdout: "x86_64\n", stderr: "" };
    if (argv[0]?.endsWith("/bun") && argv[1] === "--version") {
      return { stdout: "1.3.14\n", stderr: "" };
    }
    if (argv[0] === "sha256sum") {
      return {
        stdout: "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6  node.tar.xz\n",
        stderr: "",
      };
    }
    if (argv[0] === "cat" && argv[1]?.endsWith("/envelope.json")) {
      return {
        stdout: JSON.stringify({
          summary: "Document architecture assessment",
          evidence: ["RIFF-39 requests documentation"],
          changes: [
            {
              path: "docs/a.md",
              action: "add",
              rationale: "Document assessment",
            },
          ],
          verification: ["Run bun run validate"],
          risks: [],
          decisionsNeeded: [],
        }),
        stderr: "",
      };
    }
    if (argv.includes("rev-parse")) return { stdout: "a".repeat(40) + "\n", stderr: "" };
    if (argv.includes("diff")) return { stdout: PATCH, stderr: "" };
    return { stdout: "", stderr: "" };
  }

  async copyTo(destination: string, localPath: string, remotePath: string) {
    this.calls.push({ operation: "copyTo", value: { destination, localPath, remotePath } });
  }

  async copyFrom(destination: string, remotePath: string, localPath: string) {
    this.calls.push({ operation: "copyFrom", value: { destination, remotePath, localPath } });
    if (this.failCopy) throw new Error("copy failed");
    const source = mkdtempSync(join(tmpdir(), "factory-remote-evidence-"));
    try {
      copyFileSync(
        validArchive(source, false, this.mismatchedReviewDigest ? "0".repeat(64) : PATCH_SHA256),
        localPath,
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  }
}

class OversizedEvidenceExe extends FakeExe {
  override async copyFrom(destination: string, remotePath: string, localPath: string) {
    await super.copyFrom(destination, remotePath, localPath);
    truncateSync(localPath, 50 * 1024 * 1024 + 1);
  }
}

class KeyRemovalFailingExe extends FakeExe {
  override async exec(destination: string, argv: string[], timeoutMs?: number) {
    if (argv[0] === "rm" && argv[2] === "/home/exedev/.pi/agent/models.json") {
      await super.exec(destination, argv, timeoutMs);
      throw new Error("key removal failed");
    }
    return super.exec(destination, argv, timeoutMs);
  }
}

class OverflowExe extends FakeExe {
  override async execStream(
    destination: string,
    argv: string[],
    onStdout: (chunk: Buffer) => void,
    timeoutMs?: number,
  ) {
    this.calls.push({ operation: "execStream", value: { destination, argv, timeoutMs } });
    onStdout(Buffer.alloc(MAX_REMOTE_STREAM_BYTES + 1, 0x20));
    return { stderr: "" };
  }
}

const publishedPullRequest = {
  number: 42,
  url: "https://github.com/santychuy/bookbounce/pull/42",
  branch: `factory/riff-39-${"d".repeat(12)}`,
  commitSha: "c".repeat(40),
};
const publish = async () => publishedPullRequest;

const snapshot = {
  issue: {
    uuid: "issue-uuid",
    identifier: "RIFF-39",
    title: "Assess architecture",
    description: "Document assessment only.",
    url: "https://linear.app/riff/issue/RIFF-39",
    team: { id: "team", name: "Riffmark", key: "RIFF" },
    state: { id: "todo", name: "Todo", type: "unstarted" },
    labels: [],
    snapshotSha256: "b".repeat(64),
  },
  repository: {
    repositoryId: 1,
    fullName: "santychuy/bookbounce",
    baseRef: "main",
    baseSha: "a".repeat(40),
    private: true,
    defaultBranch: "main",
    snapshotSha256: "c".repeat(64),
  },
  idempotencyKey: "d".repeat(64),
};

function controllerOptions(root: string, exe: ControllerExe) {
  return {
    issue: "RIFF-39",
    owner: "santychuy",
    repo: "bookbounce",
    baseRef: "main",
    tag: "santychuy-bookbounce",
    identity: "/tmp/factory-key",
    timeoutSeconds: 1,
    linearToken: "linear-secret-value",
    githubToken: "github-secret-value",
    openRouterKey: "openrouter-secret-value",
    root,
    factoryRoot: testFactoryRoot(),
    exe,
    intake: async () => snapshot,
    publish,
    sleep: async () => {},
  };
}

function contains(root: string, secret: string): boolean {
  return readdirSync(root, { withFileTypes: true }).some((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return contains(path, secret);
    return statSync(path).size < 5_000_000 && readFileSync(path).includes(Buffer.from(secret));
  });
}

test("controller reaches ready only after remote evidence and VM cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const exe = new FakeExe();
  const linearToken = "linear-secret-value";
  const githubToken = "github-secret-value";
  const openRouterKey = "openrouter-secret-value";
  let accepted = false;
  try {
    const result = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/factory-key",
      timeoutSeconds: 1,
      linearToken,
      githubToken,
      openRouterKey: "openrouter-secret-value",
      root,
      factoryRoot: testFactoryRoot(),
      exe,
      intake: async () => snapshot,
      publish,
      sleep: async () => {},
      onAccepted: () => {
        accepted = true;
        assert.throws(() => acquireControllerLock(root), /lock is held/);
      },
    });
    assert.equal(accepted, true);
    assert.equal(result.status, "completed", result.error);
    assert.deepEqual(result.pullRequest, publishedPullRequest);
    const state = readControllerState(result.runDir);
    assert.equal(state.state, "completed");
    assert.equal(state.cleanup, "complete");
    assert.ok(statSync(join(result.runDir, "change.patch")).isFile());
    assert.ok(statSync(join(result.runDir, "evidence-manifest.json")).isFile());
    assert.ok(statSync(join(result.runDir, "publication.json")).isFile());
    assert.equal(statSync(result.runDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(result.runDir, "remote-evidence")).mode & 0o777, 0o700);
    for (const name of ["receipt.json", "change.patch", "evidence.tar"])
      assert.equal(statSync(join(result.runDir, name)).mode & 0o777, 0o600);
    assert.match(
      JSON.stringify(exe.calls),
      /https:\/\/github\.int\.exe\.xyz\/santychuy\/bookbounce\.git/,
    );
    assert.doesNotMatch(
      JSON.stringify(exe.calls),
      new RegExp(`${linearToken}|${githubToken}|${openRouterKey}`),
    );
    assert.doesNotMatch(JSON.stringify(exe.calls), /factory\/\/home\/exedev\/factory/);
    assert.equal(contains(root, linearToken), false);
    assert.equal(contains(root, githubToken), false);
    assert.equal(contains(root, openRouterKey), false);
    const removal = exe.calls.findIndex(
      (call) =>
        call.operation === "exec" &&
        JSON.stringify(call.value).includes('"rm","-f","/home/exedev/.pi/agent/models.json"'),
    );
    const destroy = exe.calls.findIndex((call) => call.operation === "destroy");
    assert.ok(removal >= 0);
    assert.ok(removal < destroy);
    const readiness = exe.calls.find((call) =>
      JSON.stringify(call.value).includes("https://openrouter.ai/api/v1/models"),
    );
    assert.ok(readiness);
    assert.doesNotMatch(JSON.stringify(readiness), new RegExp(openRouterKey));
    const events = readTelemetry(telemetryPath(root, state.runId));
    const contexts = events.filter((event) => event.type === "agent_context");
    assert.equal(contexts.length, 3);
    assert.ok(contexts.every((event) => /^[0-9a-f]{64}$/.test(event.payload.systemPromptSha256)));
    assert.ok(contexts.every((event) => event.payload.model === "openrouter/openai/gpt-5.6-terra"));
    assert.ok(contexts.every((event) => event.payload.executionLimits === undefined));
    assert.ok(
      contexts.every((event) => !("prompt" in event.payload) && !("systemPrompt" in event.payload)),
    );
    assert.deepEqual(
      events.filter((event) => event.type === "agent_usage").map((event) => event.payload.total),
      [14, 2, 5],
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "agent_usage")
        .map((event) => event.payload.referenceEstimateNanoUsd),
      [undefined, undefined, undefined],
    );
    assert.deepEqual(
      events.filter((event) => event.type === "phase_started").map((event) => event.phase?.name),
      [
        "creating_vm",
        "bootstrapping",
        "planning",
        "implementing",
        "verifying",
        "reviewing",
        "ready_for_publication",
        "publishing",
        "completed",
      ],
    );
    const hostClosures = events.filter(
      (event) =>
        event.type === "phase_finished" &&
        (event.phase?.name === "creating_vm" || event.phase?.name === "bootstrapping"),
    );
    assert.deepEqual(
      hostClosures.map((event) => event.phase?.name),
      ["creating_vm", "bootstrapping"],
    );
    for (const event of hostClosures) {
      assert.equal(event.type, "phase_finished");
      if (event.type === "phase_finished") assert.equal(event.payload.status, "completed");
    }
    assert.equal(events.at(-1)?.type, "run_finished");
    const publicTool = events.find((event) => event.type === "tool_started");
    assert.equal(publicTool?.payload.toolCallId, "tool-1");
    assert.equal(publicTool?.sourceAt, "1970-01-01T00:00:00.000Z");
    assert.doesNotMatch(JSON.stringify(events), /remote-private-path-content/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication failure preserves evidence and fails after VM cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const exe = new FakeExe();
  try {
    const result = await runController({
      ...controllerOptions(root, exe),
      publish: async () => {
        throw new Error("GitHub publication failed (403)");
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /publication failed \(403\)/);
    const state = readControllerState(result.runDir);
    assert.equal(state.state, "failed");
    assert.equal(state.cleanup, "complete");
    assert.ok(statSync(join(result.runDir, "change.patch")).isFile());
    const events = readTelemetry(telemetryPath(root, state.runId));
    assert.equal(
      events.some((event) => event.type === "publication_completed"),
      false,
    );
    assert.equal(events.at(-1)?.type, "run_finished");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller emits periodic phase heartbeat and stops it before terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const heartbeatRunId = "44444444-4444-4444-8444-444444444444";
  class SlowFakeExe extends FakeExe {
    override async createVm(options: { name: string; tag: string }) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((done) => setTimeout(done, 2));
        const heartbeats = readTelemetry(telemetryPath(root, heartbeatRunId)).filter(
          (event) => event.type === "heartbeat",
        );
        if (heartbeats.length >= 2) break;
      }
      return super.createVm(options);
    }
  }
  try {
    const result = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/factory-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      factoryRoot: testFactoryRoot(),
      exe: new SlowFakeExe(),
      intake: async () => snapshot,
      publish,
      sleep: async () => {},
      heartbeatMilliseconds: 1,
      runId: heartbeatRunId,
    });
    const path = telemetryPath(root, readControllerState(result.runDir).runId);
    const terminal = readTelemetry(path);
    const heartbeats = terminal.filter((event) => event.type === "heartbeat");
    assert.ok(heartbeats.length >= 2);
    assert.ok(heartbeats.some((event) => event.phase?.name === "creating_vm"));
    assert.equal(terminal.at(-1)?.type, "run_finished");
    await new Promise((done) => setTimeout(done, 15));
    assert.equal(readTelemetry(path).length, terminal.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller planner failure destroys VM and records failed state", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const exe = new FakeExe(true);
  try {
    const result = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/factory-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      factoryRoot: testFactoryRoot(),
      exe,
      intake: async () => snapshot,
      sleep: async () => {},
    });
    assert.equal(result.status, "failed");
    const state = readControllerState(result.runDir);
    assert.equal(state.state, "failed");
    assert.equal(state.cleanup, "complete");
    assert.equal(exe.calls.filter((call) => call.operation === "destroy").length, 1);
    assert.ok(
      readTelemetry(telemetryPath(root, state.runId)).some(
        (event) =>
          event.type === "artifact_available" && event.payload.name === "failure-evidence.tar",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized evidence is deleted before secret scan", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  try {
    const result = await runController(controllerOptions(root, new OversizedEvidenceExe()));
    assert.equal(result.status, "failed");
    assert.equal(existsSync(join(result.runDir, "evidence.tar")), false);
    assert.equal(existsSync(join(result.runDir, "failure-evidence.tar")), false);
    assert.ok(
      readTelemetry(telemetryPath(root, readControllerState(result.runDir).runId)).some(
        (event) => event.type === "failure" && event.payload.stage === "failure_evidence",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("key removal failure does not prevent VM destruction", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const exe = new KeyRemovalFailingExe();
  try {
    const result = await runController(controllerOptions(root, exe));
    assert.equal(result.status, "completed", result.error);
    const removal = exe.calls.findIndex(
      (call) => call.operation === "exec" && JSON.stringify(call.value).includes('"rm","-f"'),
    );
    assert.ok(removal >= 0);
    assert.ok(removal < exe.calls.findIndex((call) => call.operation === "destroy"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller exposes fixed bootstrap checkpoints without leaking raw errors", async () => {
  const cases = [
    {
      name: "repository clone",
      matches: (argv: string[]) => argv[0] === "git" && argv[1] === "clone",
      expected: "repository clone failed",
    },
    {
      name: "Factory build",
      matches: (argv: string[]) =>
        argv.some((arg) => arg.endsWith("/bun")) && argv.at(-1) === "build",
      expected: "Factory build failed",
    },
    {
      name: "OpenRouter readiness",
      matches: (argv: string[]) =>
        argv[0] === "curl" && argv.at(-1) === "https://openrouter.ai/api/v1/models",
      expected: "OpenRouter readiness check failed",
    },
  ];
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
    class BootstrapFailingExe extends FakeExe {
      override async exec(destination: string, argv: string[], timeoutMs?: number) {
        if (item.matches(argv))
          throw new Error("linear-secret-value\nprivate stderr and command arguments");
        return super.exec(destination, argv, timeoutMs);
      }
    }
    const exe = new BootstrapFailingExe();
    try {
      const result = await runController(controllerOptions(root, exe));
      assert.equal(result.status, "failed", item.name);
      const state = readControllerState(result.runDir);
      const events = readTelemetry(telemetryPath(root, state.runId));
      const primary = events.find(
        (event) => event.type === "failure" && event.payload.stage === "bootstrapping",
      );
      assert.ok(primary && primary.type === "failure", item.name);
      assert.equal(primary.payload.message, item.expected, item.name);
      assert.doesNotMatch(
        JSON.stringify(events),
        /linear-secret-value|private stderr|command arguments/,
        item.name,
      );
      assert.equal(state.cleanup, "complete", item.name);
      assert.equal(exe.calls.filter((call) => call.operation === "destroy").length, 1, item.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("failure evidence unavailability is explicit in telemetry", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const exe = new FakeExe(
    true,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
  );
  try {
    const result = await runController(controllerOptions(root, exe));
    assert.equal(result.status, "failed");
    const state = readControllerState(result.runDir);
    assert.ok(
      readTelemetry(telemetryPath(root, state.runId)).some(
        (event) => event.type === "failure" && event.payload.stage === "failure_evidence",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-review patch mutation fails digest binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const exe = new FakeExe(
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
  );
  try {
    const result = await runController(controllerOptions(root, exe));
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /lifecycle did not pass/);
    assert.equal(exe.calls.filter((call) => call.operation === "destroy").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("next run reconciles cleanup failure before intake", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  try {
    const failedCleanup = new FakeExe(false, true);
    const first = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/factory-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      factoryRoot: testFactoryRoot(),
      exe: failedCleanup,
      intake: async () => snapshot,
      sleep: async () => {},
    });
    assert.equal(first.status, "failed");
    assert.match(first.error ?? "", /revoke the dedicated OpenRouter key/);
    assert.equal(readControllerState(first.runDir).cleanup, "failed");
    assert.ok(
      failedCleanup.calls.some(
        (call) =>
          call.operation === "exec" &&
          JSON.stringify(call.value).includes('"rm","-f","/home/exedev/.pi/agent/models.json"'),
      ),
    );
    const firstState = readControllerState(first.runDir);
    writeFileSync(telemetryPath(root, firstState.runId), "{malformed}\n", { flag: "a" });

    const recovery = new FakeExe();
    await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/factory-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      factoryRoot: testFactoryRoot(),
      exe: recovery,
      intake: async () => {
        throw new Error("stop after recovery");
      },
    });
    const recovered = readControllerState(first.runDir);
    assert.equal(recovered.state, "failed");
    assert.equal(recovered.cleanup, "complete");
    assert.equal(recovery.calls[0]?.operation, "destroy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery reports complete cleanup for a derived creating_vm name", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const runId = "44444444-4444-4444-4444-444444444444";
  const runDir = join(root, ".factory", "controllers", runId);
  try {
    createControllerState(runDir, {
      runId,
      idempotencyKey: "d".repeat(64),
      issueUuid: "issue",
      issueSnapshotSha256: "b".repeat(64),
      repositoryId: 1,
      repositoryFullName: "owner/repo",
      repositorySnapshotSha256: "c".repeat(64),
      baseRef: "main",
      baseSha: "a".repeat(40),
    });
    transitionControllerState(runDir, "creating_vm");
    const telemetry = createTelemetryWriter(root, runId);
    telemetry.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    const exe = new FakeExe();
    await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/factory-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      factoryRoot: testFactoryRoot(),
      exe,
      intake: async () => {
        throw new Error("stop after recovery");
      },
    });
    const terminal = readTelemetry(telemetry.path).find((event) => event.type === "run_finished");
    assert.equal(terminal?.payload.cleanup, "complete");
    assert.equal(readControllerState(runDir).cleanup, "complete");
    assert.equal(exe.calls[0]?.operation, "destroy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active derived-name cleanup is reported complete after create response loss", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const exe = new FakeExe(false, false, false, false, false, false, false, false, false, true);
  try {
    const result = await runController(controllerOptions(root, exe));
    assert.equal(result.status, "failed");
    const receiptValue = JSON.parse(readFileSync(join(result.runDir, "receipt.json"), "utf8")) as {
      cleanup: string;
    };
    assert.equal(receiptValue.cleanup, "complete");
    const state = readControllerState(result.runDir);
    assert.equal(state.cleanup, "complete");
    const terminal = readTelemetry(telemetryPath(root, state.runId)).find(
      (event) => event.type === "run_finished",
    );
    assert.equal(terminal?.payload.cleanup, "complete");
    assert.equal(exe.calls.filter((call) => call.operation === "destroy").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed remote stream fails closed and destroys VM", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const exe = new FakeExe(false, false, true);
  try {
    const result = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/factory-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      factoryRoot: testFactoryRoot(),
      exe,
      intake: async () => snapshot,
      sleep: async () => {},
    });
    assert.equal(result.status, "failed");
    assert.equal(exe.calls.filter((call) => call.operation === "destroy").length, 1);
    assert.match(result.error ?? "", /remote protocol/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregate remote stream overflow fails run and still destroys VM", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const exe = new OverflowExe();
  try {
    const result = await runController(controllerOptions(root, exe));
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /stream exceeds limit/);
    assert.equal(exe.calls.filter((call) => call.operation === "destroy").length, 1);
    const events = readTelemetry(telemetryPath(root, readControllerState(result.runDir).runId));
    assert.equal(events.at(-1)?.type, "run_finished");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stream failure closes an already-started remote phase exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  try {
    const result = await runController(
      controllerOptions(root, new FakeExe(false, false, false, false, false, false, true)),
    );
    assert.equal(result.status, "failed");
    const state = readControllerState(result.runDir);
    const events = readTelemetry(telemetryPath(root, state.runId));
    const planningFinished = events.filter(
      (event) => event.type === "phase_finished" && event.phase?.name === "planning",
    );
    assert.equal(planningFinished.length, 1);
    const finished = planningFinished[0];
    assert.ok(finished?.type === "phase_finished");
    assert.equal(finished.payload.status, "failed");
    assert.ok(
      events.findIndex((event) => event.type === "phase_finished") <
        events.findIndex((event) => event.type === "run_finished"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed remote phase cannot progress to a later phase", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  try {
    const result = await runController(
      controllerOptions(root, new FakeExe(false, false, false, false, false, true)),
    );
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /continued after failure/);
    const state = readControllerState(result.runDir);
    const events = readTelemetry(telemetryPath(root, state.runId));
    assert.equal(
      events.some((event) => event.type === "phase_started" && event.phase?.name === "verifying"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("negative gate and review evidence terminate remote progression", async () => {
  const cases = [
    {
      exe: new FakeExe(
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
      ),
      phase: "verifying",
      forbidden: "reviewing",
    },
    {
      exe: new FakeExe(
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
      ),
      phase: "reviewing",
      forbidden: undefined,
    },
  ] as const;
  for (const { exe, phase, forbidden } of cases) {
    const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
    try {
      const result = await runController(controllerOptions(root, exe));
      assert.equal(result.status, "failed");
      assert.match(
        result.error ?? "",
        /closure contradicts negative result|continued after failure/,
      );
      const events = readTelemetry(telemetryPath(root, readControllerState(result.runDir).runId));
      const finished = events.filter(
        (event) => event.type === "phase_finished" && event.phase?.name === phase,
      );
      assert.equal(finished.length, 1);
      const phaseFinished = finished[0];
      assert.ok(phaseFinished?.type === "phase_finished");
      assert.equal(phaseFinished.payload.status, "failed");
      if (forbidden)
        assert.equal(
          events.some((event) => event.type === "phase_started" && event.phase?.name === forbidden),
          false,
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("normal failed gate and review streams close phases before failed terminal result", async () => {
  const cases = [
    {
      exe: new FakeExe(
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
      ),
      phase: "verifying",
    },
    {
      exe: new FakeExe(
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
      ),
      phase: "reviewing",
    },
  ] as const;
  for (const { exe, phase } of cases) {
    const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
    try {
      const result = await runController(controllerOptions(root, exe));
      assert.equal(result.status, "failed");
      assert.doesNotMatch(result.error ?? "", /remote phase|protocol/);
      const events = readTelemetry(telemetryPath(root, readControllerState(result.runDir).runId));
      const finished = events.filter(
        (event) => event.type === "phase_finished" && event.phase?.name === phase,
      );
      assert.equal(finished.length, 1);
      assert.ok(finished[0]?.type === "phase_finished");
      assert.equal(finished[0].payload.status, "failed");
      assert.equal(events.at(-1)?.type, "run_finished");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("remote tool IDs and invalid role tools cannot enter public telemetry", async () => {
  for (const exe of [
    new FakeExe(false, false, false, false, false, false, false, true),
    new FakeExe(false, false, false, false, false, false, false, false, true),
  ]) {
    const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
    try {
      const result = await runController(controllerOptions(root, exe));
      assert.equal(result.status, "failed");
      const state = readControllerState(result.runDir);
      const serialized = JSON.stringify(readTelemetry(telemetryPath(root, state.runId)));
      assert.doesNotMatch(serialized, /remote-private-path-content|different-remote-id/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("remote command cannot select a future controller phase", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const exe = new FakeExe(false, false, false, true);
  try {
    const result = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/factory-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      factoryRoot: testFactoryRoot(),
      exe,
      intake: async () => snapshot,
      sleep: async () => {},
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /phase sequence/);
    assert.equal(exe.calls.filter((call) => call.operation === "destroy").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed remote result requires deterministic gate evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const exe = new FakeExe(false, false, false, false, true);
  try {
    const result = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/factory-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      factoryRoot: testFactoryRoot(),
      exe,
      intake: async () => snapshot,
      sleep: async () => {},
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /contradicts/);
    assert.equal(exe.calls.filter((call) => call.operation === "destroy").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("telemetry append failure after VM creation fails closed and destroys VM", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const exe = new FakeExe();
  let appends = 0;
  try {
    const result = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/factory-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      factoryRoot: testFactoryRoot(),
      exe,
      intake: async () => snapshot,
      sleep: async () => {},
      telemetry: (telemetryRoot, runId) => {
        const writer = createTelemetryWriter(telemetryRoot, runId);
        return {
          path: writer.path,
          append(input) {
            appends += 1;
            if (appends === 4) throw new Error("disk unavailable");
            return writer.append(input);
          },
        };
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(exe.calls.filter((call) => call.operation === "destroy").length, 1);
    assert.match(result.error ?? "", /telemetry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller preserves and redacts intake failure evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  const exe = new FakeExe();
  const linearToken = "linear-secret-value";
  try {
    const result = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/factory-key",
      timeoutSeconds: 1,
      linearToken,
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      factoryRoot: testFactoryRoot(),
      exe,
      intake: async () => {
        throw new Error(`request failed: ${linearToken}`);
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(contains(result.runDir, linearToken), false);
    assert.match(readFileSync(join(result.runDir, "receipt.json"), "utf8"), /\[REDACTED\]/);
    assert.equal(
      exe.calls.some((call) => call.operation === "create"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
