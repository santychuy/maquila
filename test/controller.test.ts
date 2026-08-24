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
  archiveMaquila,
  harvest,
  recoverAbandonedAttempts,
  runController,
  type ControllerExe,
} from "../src/controller.js";
import { createFeaturePrExecution } from "../src/workflows/execution.js";
import { createFeaturePrManifest, featurePrDefinitionSha256 } from "../src/workflows/manifest.js";
import { acquireControllerLock } from "../src/controller-lock.js";
import { ExeCommandError } from "../src/integrations/exe.js";
import { createLinearDecisionComment } from "../src/integrations/linear.js";
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
  "44444444-4444-4444-4444-444444444444",
];
const BASE_SHA = "a".repeat(40);
const DOCS_PATCH = [
  "diff --git a/docs/a.md b/docs/a.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/a.md",
  "@@ -0,0 +1 @@",
  "+Documented behavior",
  "",
].join("\n");
const SOURCE_PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/a.ts",
  "@@ -0,0 +1 @@",
  "+export const implemented = true;",
  "",
].join("\n");
const PATCH = `${DOCS_PATCH}${SOURCE_PATCH}`;
const PATCH_SHA256 = createHash("sha256").update(PATCH).digest("hex");
const DOCS_PATCH_SHA256 = createHash("sha256").update(DOCS_PATCH).digest("hex");
let maquilaRoot: string | undefined;
function testMaquilaRoot(): string {
  if (maquilaRoot) return maquilaRoot;
  maquilaRoot = mkdtempSync(join(tmpdir(), "maquila-runtime-"));
  mkdirSync(join(maquilaRoot, "src", "agents"), { recursive: true });
  for (const role of ["planner", "worker", "documenter", "reviewer"]) {
    copyFileSync(
      join(process.cwd(), "src", "agents", `${role}.md`),
      join(maquilaRoot, "src", "agents", `${role}.md`),
    );
  }
  execFileSync("git", ["init", "--quiet"], { cwd: maquilaRoot });
  execFileSync("git", ["add", "src"], { cwd: maquilaRoot });
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
    { cwd: maquilaRoot },
  );
  return maquilaRoot;
}
after(() => {
  if (maquilaRoot) rmSync(maquilaRoot, { recursive: true, force: true });
});

test("runtime archive writes large repositories without buffering stdout", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-large-runtime-"));
  let archive: ReturnType<typeof archiveMaquila> | undefined;
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeFileSync(join(root, "large.bin"), Buffer.alloc(1_100_000));
    execFileSync("git", ["add", "large.bin"], { cwd: root });
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
        "large runtime",
      ],
      { cwd: root },
    );
    archive = archiveMaquila(root);
    assert.ok(statSync(archive.path).size > 1_000_000);
  } finally {
    archive?.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery terminalizes an accepted child that died before intake state", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-attempt-"));
  const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  try {
    const attempt = join(root, ".maquila", "attempts", runId);
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
function mixedHarvest(patchSha256 = PATCH_SHA256) {
  const manifest = createFeaturePrManifest({
    plannerRunId: ids[0]!,
    baseSha: BASE_SHA,
    plan: {
      summary: "Document architecture assessment",
      evidence: ["RIFF-39 requests documentation"],
      changes: [
        { path: "src/a.ts", action: "add", rationale: "Implement assessment" },
        { path: "docs/a.md", action: "add", rationale: "Document assessment" },
      ],
      verification: ["Run bun run check"],
      risks: [],
      decisionsNeeded: [],
    },
  });
  return {
    manifest,
    execution: createFeaturePrExecution({
      manifest,
      implementRunId: ids[1]!,
      documenterRunId: ids[2]!,
      reviewerRunId: ids[3]!,
      reviewedPatchSha256: patchSha256,
    }),
  };
}
function docsHarvest() {
  const manifest = createFeaturePrManifest({
    plannerRunId: ids[0]!,
    baseSha: BASE_SHA,
    plan: {
      summary: "Docs",
      evidence: ["fact"],
      changes: [{ path: "docs/a.md", action: "add", rationale: "Docs" }],
      verification: ["check"],
      risks: [],
      decisionsNeeded: [],
    },
  });
  return {
    manifest,
    execution: createFeaturePrExecution({
      manifest,
      documenterRunId: ids[2]!,
      reviewerRunId: ids[3]!,
      reviewedPatchSha256: DOCS_PATCH_SHA256,
    }),
  };
}
const HARVEST_EXPECTED = mixedHarvest();
function file(root: string, run: string, name: string, value = "{}") {
  const path = join(root, ".maquila", "runs", run, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, value);
}
function receipt(
  runId: string,
  role: "planner" | "worker" | "documenter" | "reviewer",
  artifacts: string[],
): string {
  return JSON.stringify({
    runId,
    status: "completed",
    baseSha: BASE_SHA,
    ...(role === "reviewer" ? { workerRunId: ids[1], documenterRunId: ids[2] } : {}),
    agent: { name: role },
    artifacts,
  });
}
function validArchive(root: string, unsafeLink = false, reviewDigest = PATCH_SHA256): string {
  const verification = {
    passed: true,
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
      changedPaths: ["docs/a.md", "src/a.ts"],
      unexpectedPaths: [],
      reason: null,
    },
  };
  const lifecycle = {
    status: "completed",
    stage: "reviewer",
    baseSha: BASE_SHA,
    allowedPaths: ["docs/a.md", "src/a.ts"],
    workerRunId: ids[1],
    documenterRunId: ids[2],
    reviewerRunId: ids[3],
    workerRunDir: `/home/exedev/maquila/.maquila/runs/${ids[1]}`,
    documenterRunDir: `/home/exedev/maquila/.maquila/runs/${ids[2]}`,
    reviewerRunDir: `/home/exedev/maquila/.maquila/runs/${ids[3]}`,
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
      changes: [
        { path: "src/a.ts", action: "add", rationale: "Implement assessment" },
        { path: "docs/a.md", action: "add", rationale: "Document assessment" },
      ],
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
      "workflow-execution.json",
    ]),
  );
  file(
    root,
    ids[1]!,
    "envelope.json",
    JSON.stringify({
      implemented: "Implemented assessment",
      changedFiles: ["src/a.ts"],
      validation: [{ command: "bun run check", outcome: "pass", detail: "passed" }],
      openRisks: [],
    }),
  );
  file(root, ids[1]!, "lifecycle.json", JSON.stringify(lifecycle));
  file(root, ids[1]!, "verification.json", JSON.stringify(verification));
  file(root, ids[1]!, "review-diff.sha256", `${reviewDigest}\n`);
  file(
    root,
    ids[1]!,
    "workflow-execution.json",
    JSON.stringify(mixedHarvest(reviewDigest).execution),
  );
  file(root, ids[2]!, "receipt.json", receipt(ids[2]!, "documenter", ["envelope.json"]));
  file(
    root,
    ids[2]!,
    "envelope.json",
    JSON.stringify({
      outcome: "updated",
      changedFiles: ["docs/a.md"],
      detail: "Documented assessment",
    }),
  );
  file(
    root,
    ids[3]!,
    "receipt.json",
    receipt(ids[3]!, "reviewer", ["envelope.json", "lifecycle.json"]),
  );
  file(root, ids[3]!, "lifecycle.json", JSON.stringify(lifecycle));
  file(
    root,
    ids[3]!,
    "envelope.json",
    JSON.stringify({
      verdict: "PASS",
      correct: ["Verification passed"],
      blockingFindings: [],
      nonBlockingFindings: [],
      residualRisks: [],
    }),
  );
  if (unsafeLink) symlinkSync("/tmp", join(root, ".maquila", "runs", ids[0]!, "unsafe-link"));
  const archive = join(root, "evidence.tar");
  execFileSync("tar", ["-cf", archive, "-C", root, ".maquila/runs"]);
  return archive;
}
function validDocsOnlyArchive(root: string): string {
  validArchive(root);
  rmSync(join(root, ".maquila", "runs", ids[1]!), { recursive: true, force: true });
  const verification = {
    passed: true,
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
    documenterRunId: ids[2],
    documenterRunDir: `/home/exedev/maquila/.maquila/runs/${ids[2]}`,
    reviewerRunId: ids[3],
    reviewerRunDir: `/home/exedev/maquila/.maquila/runs/${ids[3]}`,
    reviewPatchSha256: DOCS_PATCH_SHA256,
    verification,
  };
  file(
    root,
    ids[0]!,
    "envelope.json",
    JSON.stringify({
      summary: "Docs",
      evidence: ["fact"],
      changes: [{ path: "docs/a.md", action: "add", rationale: "Docs" }],
      verification: ["check"],
      risks: [],
      decisionsNeeded: [],
    }),
  );
  file(
    root,
    ids[2]!,
    "receipt.json",
    receipt(ids[2]!, "documenter", [
      "envelope.json",
      "lifecycle.json",
      "verification.json",
      "review-diff.sha256",
      "workflow-execution.json",
    ]),
  );
  file(root, ids[2]!, "lifecycle.json", JSON.stringify(lifecycle));
  file(root, ids[2]!, "verification.json", JSON.stringify(verification));
  file(root, ids[2]!, "review-diff.sha256", `${DOCS_PATCH_SHA256}\n`);
  file(root, ids[2]!, "workflow-execution.json", JSON.stringify(docsHarvest().execution));
  file(
    root,
    ids[3]!,
    "receipt.json",
    JSON.stringify({
      runId: ids[3],
      status: "completed",
      baseSha: BASE_SHA,
      documenterRunId: ids[2],
      agent: { name: "reviewer" },
      artifacts: ["envelope.json", "lifecycle.json"],
    }),
  );
  file(root, ids[3]!, "lifecycle.json", JSON.stringify(lifecycle));
  const archive = join(root, "docs-evidence.tar");
  execFileSync("tar", ["-cf", archive, "-C", root, ".maquila/runs"]);
  return archive;
}

test("controller patch fixtures are valid Git patches", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-patch-fixture-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    for (const [name, patch] of [
      ["docs.patch", DOCS_PATCH],
      ["mixed.patch", PATCH],
    ] as const) {
      const path = join(root, name);
      writeFileSync(path, patch);
      execFileSync("git", ["apply", "--check", path], { cwd: root });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("harvest validates evidence requirements", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  try {
    harvest(validArchive(root), join(root, "out"), HARVEST_EXPECTED);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("harvest accepts docs-only evidence without a worker receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  try {
    harvest(validDocsOnlyArchive(root), join(root, "out"), docsHarvest());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("harvest rejects missing or mismatched workflow execution", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  try {
    validArchive(root);
    rmSync(join(root, ".maquila", "runs", ids[1]!, "workflow-execution.json"));
    const missing = join(root, "missing-execution.tar");
    execFileSync("tar", ["-cf", missing, "-C", root, ".maquila/runs"]);
    assert.throws(
      () => harvest(missing, join(root, "missing"), HARVEST_EXPECTED),
      /required remote evidence missing/,
    );
    const hashed = mixedHarvest();
    hashed.execution = { ...hashed.execution, workflowManifestSha256: "0".repeat(64) };
    assert.throws(
      () => harvest(validArchive(join(root, "hash-src")), join(root, "hash"), hashed),
      /manifest hash mismatch/,
    );
    const skipped = mixedHarvest();
    skipped.execution = {
      ...skipped.execution,
      steps: [
        { id: "implement", status: "skipped", skipReason: "docs-only" },
        skipped.execution.steps[1],
        skipped.execution.steps[2],
        skipped.execution.steps[3],
      ],
    };
    assert.throws(
      () => harvest(validArchive(join(root, "skip-src")), join(root, "skip"), skipped),
      /does not match manifest/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("harvest rejects traversal run identifiers", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  try {
    assert.throws(
      () =>
        harvest(validArchive(root), join(root, "out"), {
          ...HARVEST_EXPECTED,
          execution: {
            ...HARVEST_EXPECTED.execution,
            steps: [
              {
                id: "implement",
                status: "completed",
                runId: "../bad",
              },
              HARVEST_EXPECTED.execution.steps[1],
              HARVEST_EXPECTED.execution.steps[2],
              HARVEST_EXPECTED.execution.steps[3],
            ],
          },
        }),
      /invalid workflow execution|unsafe remote run id/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("harvest rejects duplicate run identities and mismatched receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  try {
    const archive = validArchive(root);
    assert.throws(
      () =>
        harvest(archive, join(root, "duplicate"), {
          ...HARVEST_EXPECTED,
          execution: {
            ...HARVEST_EXPECTED.execution,
            steps: [
              {
                id: "implement",
                status: "completed",
                runId: ids[1]!,
              },
              { id: "document", status: "completed", runId: ids[1]! },
              HARVEST_EXPECTED.execution.steps[2],
              HARVEST_EXPECTED.execution.steps[3],
            ],
          },
        }),
      /does not match manifest|distinct|unexpected runs/,
    );
    file(root, ids[0]!, "receipt.json", receipt(ids[1]!, "planner", ["envelope.json", "plan.md"]));
    const mismatched = join(root, "mismatched.tar");
    execFileSync("tar", ["-cf", mismatched, "-C", root, ".maquila/runs"]);
    assert.throws(
      () => harvest(mismatched, join(root, "mismatch"), HARVEST_EXPECTED),
      /did not pass/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("harvest binds verification, role links, base SHA, and reviewed patch", () => {
  const cases: Array<{ name: string; mutate(root: string): void }> = [
    {
      name: "command differs from manifest",
      mutate(root) {
        const verification = JSON.parse(
          readFileSync(join(root, ".maquila", "runs", ids[1]!, "verification.json"), "utf8"),
        ) as { commands: Array<{ argv: string[] }> };
        verification.commands[0]!.argv = ["true"];
        file(root, ids[1]!, "verification.json", JSON.stringify(verification));
      },
    },
    {
      name: "failed command",
      mutate(root) {
        const verification = JSON.parse(
          readFileSync(join(root, ".maquila", "runs", ids[1]!, "verification.json"), "utf8"),
        ) as { commands: Array<{ exitCode: number }> };
        verification.commands[0]!.exitCode = 1;
        file(root, ids[1]!, "verification.json", JSON.stringify(verification));
      },
    },
    {
      name: "wrong base SHA",
      mutate(root) {
        const lifecycle = JSON.parse(
          readFileSync(join(root, ".maquila", "runs", ids[1]!, "lifecycle.json"), "utf8"),
        ) as { baseSha: string };
        lifecycle.baseSha = "b".repeat(40);
        file(root, ids[1]!, "lifecycle.json", JSON.stringify(lifecycle));
      },
    },
    {
      name: "missing reviewer link",
      mutate(root) {
        const reviewerReceipt = JSON.parse(
          readFileSync(join(root, ".maquila", "runs", ids[3]!, "receipt.json"), "utf8"),
        ) as Record<string, unknown>;
        delete reviewerReceipt.workerRunId;
        file(root, ids[3]!, "receipt.json", JSON.stringify(reviewerReceipt));
      },
    },
    {
      name: "worker changed files mismatch",
      mutate(root) {
        const envelope = JSON.parse(
          readFileSync(join(root, ".maquila", "runs", ids[1]!, "envelope.json"), "utf8"),
        ) as { changedFiles: string[] };
        envelope.changedFiles = ["src/other.ts"];
        file(root, ids[1]!, "envelope.json", JSON.stringify(envelope));
      },
    },
    {
      name: "documenter changed files mismatch",
      mutate(root) {
        const envelope = JSON.parse(
          readFileSync(join(root, ".maquila", "runs", ids[2]!, "envelope.json"), "utf8"),
        ) as { changedFiles: string[] };
        envelope.changedFiles = ["docs/other.md"];
        file(root, ids[2]!, "envelope.json", JSON.stringify(envelope));
      },
    },
    {
      name: "missing artifact index",
      mutate(root) {
        const workerReceipt = JSON.parse(
          readFileSync(join(root, ".maquila", "runs", ids[1]!, "receipt.json"), "utf8"),
        ) as { artifacts: string[] };
        workerReceipt.artifacts = workerReceipt.artifacts.filter(
          (name) => name !== "review-diff.sha256",
        );
        file(root, ids[1]!, "receipt.json", JSON.stringify(workerReceipt));
      },
    },
  ];
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
    try {
      validArchive(root);
      item.mutate(root);
      const archive = join(root, `${item.name.replaceAll(" ", "-")}.tar`);
      execFileSync("tar", ["-cf", archive, "-C", root, ".maquila/runs"]);
      assert.throws(
        () => harvest(archive, join(root, "out"), HARVEST_EXPECTED),
        /did not pass/,
        item.name,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("harvest rejects symbolic links", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  try {
    assert.throws(
      () => harvest(validArchive(root, true), join(root, "out"), HARVEST_EXPECTED),
      /unsafe/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class FakeExe implements ControllerExe {
  readonly calls: Array<{ operation: string; value: unknown }> = [];
  normalFailedDocumenter = false;
  documenterLifecycleStatus: "completed" | "failed" = "failed";
  documenterFailure =
    "documenter blocked: missing approved path docs/native-architecture-assessment.md";
  toolLifecycleViolation?: "before-start" | "after-finish" | "finish-with-open-tool";
  agentContent?: string;
  interleaveAgentContent = false;

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
        stepId: "plan",
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
        protocol.event({
          type: "phase_started",
          actor: "worker",
          phase: "implementing",
          stepId: "implement",
          sourceAt,
        });
      else
        protocol.event({
          type: "phase_started",
          actor: "planner",
          phase: "planning",
          stepId: "plan",
          sourceAt,
        });
      if (!this.invalidSequence) {
        if (this.toolLifecycleViolation === "before-start")
          protocol.event({
            type: "tool_started",
            actor: "planner",
            phase: "planning",
            stepId: "plan",
            toolName: "read",
            toolCallId: "early-tool",
            sourceAt,
          });
        protocol.event({
          type: "agent_started",
          actor: "planner",
          phase: "planning",
          stepId: "plan",
          sourceAt,
        });
        if (this.agentContent) {
          const split = Math.floor(this.agentContent.length / 2);
          for (const [chunkIndex, text] of [
            this.agentContent.slice(0, split),
            this.agentContent.slice(split),
          ].entries()) {
            protocol.event({
              type: "agent_content",
              actor: "planner",
              phase: "planning",
              stepId: "plan",
              contentId: "prompt-1",
              kind: "user_prompt",
              chunkIndex,
              chunkCount: 2,
              text,
              sourceAt,
            });
            if (chunkIndex === 0 && this.interleaveAgentContent)
              protocol.event({
                type: "tool_started",
                actor: "planner",
                phase: "planning",
                stepId: "plan",
                toolName: "read",
                toolCallId: "interleaved-tool",
                sourceAt,
              });
          }
        }
        protocol.event({
          type: "tool_started",
          actor: "planner",
          phase: "planning",
          stepId: "plan",
          toolName: this.invalidToolActivity ? "bash" : "read",
          toolCallId: "remote-private-path-content",
          sourceAt,
        });
        if (this.toolLifecycleViolation !== "finish-with-open-tool")
          protocol.event({
            type: "tool_finished",
            actor: "planner",
            phase: "planning",
            stepId: "plan",
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
          stepId: "plan",
          status: "completed",
          sourceAt,
        });
        if (this.toolLifecycleViolation === "after-finish")
          protocol.event({
            type: "tool_started",
            actor: "planner",
            phase: "planning",
            stepId: "plan",
            toolName: "read",
            toolCallId: "late-tool",
            sourceAt,
          });
        protocol.event({
          type: "agent_usage",
          actor: "planner",
          phase: "planning",
          stepId: "plan",
          tokens: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, total: 14 },
          contextTokens: 50_000,
          contextWindow: 200_000,
          sourceAt,
        });
      }
      protocol.event({
        type: "phase_finished",
        actor: this.invalidSequence ? "worker" : "planner",
        phase: this.invalidSequence ? "implementing" : "planning",
        stepId: this.invalidSequence ? "implement" : "plan",
        status: "completed",
        sourceAt,
      });
      protocol.result({
        status: this.failPlanner ? "failed" : "completed",
        runDir: `/home/exedev/maquila/.maquila/runs/${ids[0]}`,
        ...(this.failPlanner
          ? { failure: { phase: "planning" as const, code: "model_request_failed" as const } }
          : {}),
      });
    } else {
      protocol.event({
        type: "phase_started",
        actor: "worker",
        phase: "implementing",
        stepId: "implement",
        sourceAt,
      });
      protocol.event({
        type: "agent_started",
        actor: "worker",
        phase: "implementing",
        stepId: "implement",
        sourceAt,
      });
      protocol.event({
        type: "agent_finished",
        actor: "worker",
        phase: "implementing",
        stepId: "implement",
        status: "completed",
        sourceAt,
      });
      protocol.event({
        type: "agent_usage",
        actor: "worker",
        phase: "implementing",
        stepId: "implement",
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        sourceAt,
      });
      if (this.failedPhaseProgression) {
        protocol.event({
          type: "phase_finished",
          actor: "worker",
          phase: "implementing",
          stepId: "implement",
          status: "failed",
          sourceAt,
        });
        protocol.event({
          type: "phase_started",
          actor: "verifier",
          phase: "verifying",
          stepId: "verify",
          sourceAt,
        });
        protocol.result({
          status: "failed",
          runDir: `/home/exedev/maquila/.maquila/runs/${ids[1]}`,
        });
        onStdout(Buffer.from(output.join("")));
        return { stderr: "" };
      }
      protocol.event({
        type: "phase_finished",
        actor: "worker",
        phase: "implementing",
        stepId: "implement",
        status: "completed",
        sourceAt,
      });
      protocol.event({
        type: "phase_started",
        actor: "documenter",
        phase: "documenting",
        stepId: "document",
        sourceAt,
      });
      protocol.event({
        type: "agent_started",
        actor: "documenter",
        phase: "documenting",
        stepId: "document",
        sourceAt,
      });
      protocol.event({
        type: "agent_finished",
        actor: "documenter",
        phase: "documenting",
        stepId: "document",
        status: "completed",
        sourceAt,
      });
      protocol.event({
        type: "agent_usage",
        actor: "documenter",
        phase: "documenting",
        stepId: "document",
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        sourceAt,
      });
      protocol.event({
        type: "phase_finished",
        actor: "documenter",
        phase: "documenting",
        stepId: "document",
        status: this.normalFailedDocumenter ? "failed" : "completed",
        sourceAt,
      });
      if (this.normalFailedDocumenter) {
        protocol.result({
          status: "failed",
          runDir: `/home/exedev/maquila/.maquila/runs/${ids[1]}`,
          failure: { phase: "documenting", code: "agent_failed" },
        });
        onStdout(Buffer.from(output.join("")));
        return { stderr: "" };
      }
      protocol.event({
        type: "phase_started",
        actor: "verifier",
        phase: "verifying",
        stepId: "verify",
        sourceAt,
      });
      if (!this.missingGate)
        protocol.event({
          type: "gate_finished",
          actor: "verifier",
          phase: "verifying",
          stepId: "verify",
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
        stepId: "verify",
        status: this.normalFailedGate ? "failed" : "completed",
        sourceAt,
      });
      if (this.normalFailedGate) {
        protocol.result({
          status: "failed",
          runDir: `/home/exedev/maquila/.maquila/runs/${ids[1]}`,
        });
        onStdout(Buffer.from(output.join("")));
        return { stderr: "" };
      }
      protocol.event({
        type: "phase_started",
        actor: "reviewer",
        phase: "reviewing",
        stepId: "review",
        sourceAt,
      });
      protocol.event({
        type: "agent_started",
        actor: "reviewer",
        phase: "reviewing",
        stepId: "review",
        sourceAt,
      });
      protocol.event({
        type: "agent_finished",
        actor: "reviewer",
        phase: "reviewing",
        stepId: "review",
        status: "completed",
        sourceAt,
      });
      protocol.event({
        type: "agent_usage",
        actor: "reviewer",
        phase: "reviewing",
        stepId: "review",
        tokens: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, total: 5 },
        sourceAt,
      });
      protocol.event({
        type: "review_finished",
        actor: "reviewer",
        phase: "reviewing",
        stepId: "review",
        verdict: this.failedReviewProgression || this.normalFailedReview ? "FAIL" : "PASS",
        blockerCount: this.failedReviewProgression || this.normalFailedReview ? 1 : 0,
        sourceAt,
      });
      protocol.event({
        type: "phase_finished",
        actor: "reviewer",
        phase: "reviewing",
        stepId: "review",
        status: this.normalFailedReview ? "failed" : "completed",
        sourceAt,
      });
      protocol.result({
        status: this.normalFailedReview ? "failed" : "completed",
        runDir: `/home/exedev/maquila/.maquila/runs/${ids[1]}`,
        reviewerRunDir: `/home/exedev/maquila/.maquila/runs/${ids[3]}`,
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
        ? `\nRun evidence: /home/exedev/maquila/.maquila/runs/${ids[0]}\n`
        : `\nRun evidence: /home/exedev/maquila/.maquila/runs/${ids[1]}\nReviewer evidence: /home/exedev/maquila/.maquila/runs/${ids[3]}\n`;
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
    if (argv[0] === "cat" && argv[1]?.endsWith("/workflow-execution.json")) {
      return {
        stdout: JSON.stringify(mixedHarvest().execution),
        stderr: "",
      };
    }
    if (argv[0] === "cat" && argv[1]?.endsWith("/lifecycle.json")) {
      return {
        stdout: JSON.stringify(
          this.normalFailedDocumenter
            ? {
                status: this.documenterLifecycleStatus,
                stage: "documenter",
                error: this.documenterFailure,
              }
            : { documenterRunDir: `/home/exedev/maquila/.maquila/runs/${ids[2]}` },
        ),
        stderr: "",
      };
    }
    if (argv[0] === "cat" && argv[1]?.endsWith("/envelope.json")) {
      return {
        stdout: JSON.stringify({
          summary: "Document architecture assessment",
          evidence: ["RIFF-39 requests documentation"],
          changes: [
            { path: "src/a.ts", action: "add", rationale: "Implement assessment" },
            { path: "docs/a.md", action: "add", rationale: "Document assessment" },
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
    const source = mkdtempSync(join(tmpdir(), "maquila-remote-evidence-"));
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

class MisleadingLifecycleExe extends FakeExe {
  override async exec(destination: string, argv: string[], timeoutMs?: number) {
    if (argv[0] === "cat" && argv[1]?.endsWith("/lifecycle.json")) {
      this.calls.push({ operation: "exec", value: { destination, argv, timeoutMs } });
      return {
        stdout: JSON.stringify({
          documenterRunDir:
            "/home/exedev/maquila/.maquila/runs/55555555-5555-4555-8555-555555555555",
        }),
        stderr: "",
      };
    }
    return super.exec(destination, argv, timeoutMs);
  }
}

class BlockedPlannerExe extends FakeExe {
  override async exec(destination: string, argv: string[], timeoutMs?: number) {
    if (argv[0] === "cat" && argv[1]?.endsWith("/receipt.json")) {
      this.calls.push({ operation: "exec", value: { destination, argv, timeoutMs } });
      return {
        stdout: JSON.stringify({
          sessionId: "planner-session",
          sessionFile: `/home/exedev/maquila/.maquila/runs/${ids[0]}/sessions/planner.jsonl`,
        }),
        stderr: "",
      };
    }
    if (argv[0] === "cat" && argv[1]?.endsWith("/envelope.json")) {
      this.calls.push({ operation: "exec", value: { destination, argv, timeoutMs } });
      return {
        stdout: JSON.stringify({
          summary: "Blocked plan",
          evidence: ["Issue contains an unresolved product decision"],
          changes: [],
          verification: [],
          risks: [],
          decisionsNeeded: ["Choose preserved or unified behavior"],
        }),
        stderr: "",
      };
    }
    return super.exec(destination, argv, timeoutMs);
  }

  override async copyFrom(destination: string, remotePath: string, localPath: string) {
    if (remotePath.endsWith("planner.jsonl")) {
      this.calls.push({ operation: "copyFrom", value: { destination, remotePath, localPath } });
      writeFileSync(localPath, '{"type":"session"}\n');
      return;
    }
    return super.copyFrom(destination, remotePath, localPath);
  }
}

class ResumingPlannerExe extends FakeExe {
  private envelopes = 0;
  private checkpoints = 0;

  constructor(private readonly blockedEnvelopes = 1) {
    super();
  }

  override async exec(destination: string, argv: string[], timeoutMs?: number) {
    if (argv[0] === "cat" && argv[1]?.endsWith("/receipt.json")) {
      this.calls.push({ operation: "exec", value: { destination, argv, timeoutMs } });
      return {
        stdout: JSON.stringify({
          sessionId: "planner-session",
          sessionFile: `/home/exedev/maquila/.maquila/runs/${ids[0]}/sessions/planner.jsonl`,
        }),
        stderr: "",
      };
    }
    if (argv[0] === "cat" && argv[1]?.endsWith("/envelope.json")) {
      this.envelopes += 1;
      if (this.envelopes <= this.blockedEnvelopes) {
        this.calls.push({ operation: "exec", value: { destination, argv, timeoutMs } });
        return {
          stdout: JSON.stringify({
            summary: "Blocked plan",
            evidence: ["Issue needs a decision"],
            changes: [],
            verification: [],
            risks: [],
            decisionsNeeded: ["Choose behavior"],
          }),
          stderr: "",
        };
      }
    }
    return super.exec(destination, argv, timeoutMs);
  }

  override async copyFrom(destination: string, remotePath: string, localPath: string) {
    if (remotePath.endsWith("planner.jsonl")) {
      this.calls.push({ operation: "copyFrom", value: { destination, remotePath, localPath } });
      this.checkpoints += 1;
      writeFileSync(
        localPath,
        `${JSON.stringify({ type: "session", checkpoint: this.checkpoints })}\n`,
      );
      return;
    }
    return super.copyFrom(destination, remotePath, localPath);
  }
}

class MissingRetainedVmExe extends ResumingPlannerExe {
  missing = false;

  override async exec(destination: string, argv: string[], timeoutMs?: number) {
    if (this.missing && argv.length === 1 && argv[0] === "true") {
      this.missing = false;
      throw new Error("missing VM");
    }
    return super.exec(destination, argv, timeoutMs);
  }
}

class DocsOnlyExe extends FakeExe {
  override async execStream(
    destination: string,
    argv: string[],
    onStdout: (chunk: Buffer) => void,
    timeoutMs?: number,
  ) {
    if (argv.includes("plan")) return super.execStream(destination, argv, onStdout, timeoutMs);
    this.calls.push({ operation: "execStream", value: { destination, argv, timeoutMs } });
    const output: string[] = [];
    const protocol = createRemoteProtocolWriter((line) => output.push(line));
    const sourceAt = "1970-01-01T00:00:00.000+00:00";
    protocol.event({
      type: "phase_started",
      actor: "documenter",
      phase: "documenting",
      stepId: "document",
      sourceAt,
    });
    protocol.event({
      type: "agent_started",
      actor: "documenter",
      phase: "documenting",
      stepId: "document",
      sourceAt,
    });
    protocol.event({
      type: "agent_finished",
      actor: "documenter",
      phase: "documenting",
      stepId: "document",
      status: "completed",
      sourceAt,
    });
    protocol.event({
      type: "agent_usage",
      actor: "documenter",
      phase: "documenting",
      stepId: "document",
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      sourceAt,
    });
    protocol.event({
      type: "phase_finished",
      actor: "documenter",
      phase: "documenting",
      stepId: "document",
      status: "completed",
      sourceAt,
    });
    protocol.event({
      type: "phase_started",
      actor: "verifier",
      phase: "verifying",
      stepId: "verify",
      sourceAt,
    });
    protocol.event({
      type: "gate_finished",
      actor: "verifier",
      phase: "verifying",
      stepId: "verify",
      passed: true,
      commandCount: 1,
      changedPathCount: 1,
      timedOut: false,
      sourceAt,
    });
    protocol.event({
      type: "phase_finished",
      actor: "verifier",
      phase: "verifying",
      stepId: "verify",
      status: "completed",
      sourceAt,
    });
    protocol.event({
      type: "phase_started",
      actor: "reviewer",
      phase: "reviewing",
      stepId: "review",
      sourceAt,
    });
    protocol.event({
      type: "agent_started",
      actor: "reviewer",
      phase: "reviewing",
      stepId: "review",
      sourceAt,
    });
    protocol.event({
      type: "agent_finished",
      actor: "reviewer",
      phase: "reviewing",
      stepId: "review",
      status: "completed",
      sourceAt,
    });
    protocol.event({
      type: "agent_usage",
      actor: "reviewer",
      phase: "reviewing",
      stepId: "review",
      tokens: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, total: 5 },
      sourceAt,
    });
    protocol.event({
      type: "review_finished",
      actor: "reviewer",
      phase: "reviewing",
      stepId: "review",
      verdict: "PASS",
      blockerCount: 0,
      sourceAt,
    });
    protocol.event({
      type: "phase_finished",
      actor: "reviewer",
      phase: "reviewing",
      stepId: "review",
      status: "completed",
      sourceAt,
    });
    protocol.result({
      status: "completed",
      runDir: `/home/exedev/maquila/.maquila/runs/${ids[2]}`,
      reviewerRunDir: `/home/exedev/maquila/.maquila/runs/${ids[3]}`,
    });
    onStdout(Buffer.from(output.join("")));
    return { stderr: "" };
  }

  override async exec(destination: string, argv: string[], timeoutMs?: number) {
    if (argv[0] === "cat" && argv[1]?.endsWith("/workflow-execution.json")) {
      this.calls.push({ operation: "exec", value: { destination, argv, timeoutMs } });
      return { stdout: JSON.stringify(docsHarvest().execution), stderr: "" };
    }
    if (argv[0] === "cat" && argv[1]?.endsWith("/envelope.json")) {
      this.calls.push({ operation: "exec", value: { destination, argv, timeoutMs } });
      return {
        stdout: JSON.stringify({
          summary: "Docs",
          evidence: ["fact"],
          changes: [{ path: "docs/a.md", action: "add", rationale: "Docs" }],
          verification: ["check"],
          risks: [],
          decisionsNeeded: [],
        }),
        stderr: "",
      };
    }
    if (argv.includes("diff")) {
      this.calls.push({ operation: "exec", value: { destination, argv, timeoutMs } });
      return { stdout: DOCS_PATCH, stderr: "" };
    }
    return super.exec(destination, argv, timeoutMs);
  }

  override async copyFrom(destination: string, remotePath: string, localPath: string) {
    this.calls.push({ operation: "copyFrom", value: { destination, remotePath, localPath } });
    const source = mkdtempSync(join(tmpdir(), "maquila-docs-only-evidence-"));
    try {
      copyFileSync(validDocsOnlyArchive(source), localPath);
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
  branch: `maquila/riff-39-${"d".repeat(12)}`,
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
    assignee: {
      id: "user-1",
      name: "Santiago",
      url: "https://linear.app/riff/profiles/santiago",
    },
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
    identity: "/tmp/maquila-key",
    timeoutSeconds: 1,
    linearToken: "linear-secret-value",
    githubToken: "github-secret-value",
    openRouterKey: "openrouter-secret-value",
    root,
    maquilaRoot: testMaquilaRoot(),
    exe,
    intake: async () => snapshot,
    createDecisionComment: async (input: Parameters<typeof createLinearDecisionComment>[0]) => ({
      commentId: "decision-comment-1",
      commentUrl: "https://linear.app/riff/comment/decision-comment-1",
      issueId: "issue-uuid",
      assigneeId: "user-1",
      generation: input.generation ?? 1,
      questionSha256: "e".repeat(64),
      questionCount: input.decisions.length,
      requestedAt: "2026-01-01T00:00:00.000Z",
      marker: `<!-- maquila-decision:${input.runId}:${input.generation ?? 1}:${"e".repeat(64)} -->`,
    }),
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

test("controller rejects events interleaved with incomplete agent content", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-content-order-"));
  const exe = new FakeExe();
  exe.agentContent = "prompt";
  exe.interleaveAgentContent = true;
  try {
    const result = await runController(controllerOptions(root, exe));
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /interleaved with incomplete agent content/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller rejects known credentials split across remote content chunks", async () => {
  for (const key of ["linearToken", "githubToken", "openRouterKey"] as const) {
    const root = mkdtempSync(join(tmpdir(), "maquila-controller-content-secret-"));
    const exe = new FakeExe();
    const options = controllerOptions(root, exe);
    exe.agentContent = options[key];
    try {
      const result = await runController(options);
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /secret detected in retained artifact/);
      assert.equal(contains(root, options[key]), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("controller requests an assigned engineer decision without failing", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  try {
    const result = await runController(controllerOptions(root, new BlockedPlannerExe()));
    assert.equal(result.status, "awaiting_decision");
    assert.equal(result.decisionRequest?.commentId, "decision-comment-1");
    const state = readControllerState(result.runDir);
    assert.equal(state.state, "awaiting_decision");
    assert.equal(state.version, 2);
    if (state.version === 2) {
      assert.equal(state.workflow.id, "feature-pr");
      assert.equal(state.workflow.currentStepId, "plan");
      assert.equal(state.workflow.attempt, 1);
      assert.equal(state.workflow.manifestSha256, undefined);
    }
    const requested = readTelemetry(telemetryPath(root, state.runId)).find(
      (event) => event.type === "decision_requested",
    );
    assert.ok(requested?.type === "decision_requested");
    assert.equal(requested.payload.count, 1);
    assert.notEqual(readTelemetry(telemetryPath(root, state.runId)).at(-1)?.type, "run_finished");
    assert.equal(state.cleanup, "pending");
    assert.equal(state.decisionWait?.generation, 1);
    assert.ok(existsSync(join(result.runDir, "planner-session.jsonl")));
    assert.ok(existsSync(join(result.runDir, "decision-request.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller expires a retained decision wait as cancelled and cleans its VM", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new BlockedPlannerExe();
  const now = Date.now;
  try {
    const result = await runController({
      ...controllerOptions(root, exe),
      inlineDecisionWaiter: async (_request, expiresAt) => {
        Date.now = () => Date.parse(expiresAt);
        throw new Error("decision wait expired");
      },
    });
    assert.equal(result.status, "cancelled");
    const state = readControllerState(result.runDir);
    assert.equal(state.state, "cancelled");
    assert.equal(state.cleanup, "complete");
    assert.ok(exe.calls.some((call) => call.operation === "destroy"));
  } finally {
    Date.now = now;
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller resumes the same VM and planner session after a Linear decision", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new ResumingPlannerExe();
  try {
    const result = await runController({
      ...controllerOptions(root, exe),
      inlineDecisionWaiter: async () => ({
        commentId: "reply-1",
        body: "Keep the sign-in card",
        createdAt: "2026-01-02T00:00:00.000Z",
        sha256: "a".repeat(64),
      }),
    });
    assert.equal(
      result.status,
      "completed",
      `${result.error}: ${readTelemetry(
        telemetryPath(root, readControllerState(result.runDir).runId),
      )
        .map((event) => `${event.type}:${event.phase?.id ?? "-"}`)
        .join(",")}`,
    );
    assert.equal(exe.calls.filter((call) => call.operation === "create").length, 1);
    const plannerCalls = exe.calls.filter(
      (call) =>
        call.operation === "execStream" &&
        Array.isArray((call.value as { argv?: unknown }).argv) &&
        ((call.value as { argv: string[] }).argv.includes("plan") ?? false),
    );
    assert.equal(plannerCalls.length, 2);
    const resumed = (plannerCalls[1]!.value as { argv: string[] }).argv;
    assert.ok(resumed.includes("--resume-session"));
    assert.ok(resumed.includes("--session-id"));
    assert.ok(resumed.includes("planner-session"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller resumes a persisted wait after the original process exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new ResumingPlannerExe();
  try {
    const waiting = await runController(controllerOptions(root, exe));
    assert.equal(waiting.status, "awaiting_decision");
    const waitingState = readControllerState(waiting.runDir);
    const runId = waitingState.runId;
    assert.equal(waitingState.version, 2);
    const { workflow: _workflow, ...legacy } = waitingState as typeof waitingState & {
      workflow: unknown;
    };
    writeFileSync(
      join(waiting.runDir, "controller-state.json"),
      `${JSON.stringify({ ...legacy, version: 1 })}\n`,
    );
    const result = await runController({
      ...controllerOptions(root, exe),
      runId,
      resumeExisting: true,
      inlineDecisionWaiter: async () => ({
        commentId: "reply-1",
        body: "Keep the sign-in card",
        createdAt: "2026-01-02T00:00:00.000Z",
        sha256: "a".repeat(64),
      }),
    });
    assert.equal(result.status, "completed", result.error);
    const resumedState = readControllerState(result.runDir);
    assert.equal(resumedState.runId, runId);
    assert.equal(resumedState.version, 1);
    assert.equal(exe.calls.filter((call) => call.operation === "create").length, 1);
    const plannerCalls = exe.calls.filter(
      (call) =>
        call.operation === "execStream" &&
        ((call.value as { argv: string[] }).argv.includes("plan") ?? false),
    );
    assert.equal(plannerCalls.length, 2);
    assert.ok((plannerCalls[1]!.value as { argv: string[] }).argv.includes("--resume-session"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted round-2 decision wait keeps same-session evidence and remains resumable", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new ResumingPlannerExe(2);
  const options = controllerOptions(root, exe);
  try {
    const waiting = await runController(options);
    const first = readControllerState(waiting.runDir);
    assert.ok(first.version === 2 && first.decisionWait);
    const firstCheckpointSha256 = first.decisionWait.checkpointSha256;

    const round2Invocation: Parameters<typeof runController>[0] = {
      ...options,
      runId: first.runId,
      resumeExisting: true,
    };
    round2Invocation.inlineDecisionWaiter = async (request) => {
      assert.equal(request.generation, 1);
      round2Invocation.inlineDecisionWaiter = undefined;
      return {
        commentId: "reply-1",
        body: "Keep it",
        createdAt: "2026-01-02T00:00:00.000Z",
        sha256: "a".repeat(64),
      };
    };
    const round2 = await runController(round2Invocation);
    assert.equal(round2.status, "awaiting_decision");
    const second = readControllerState(waiting.runDir);
    assert.ok(second.version === 2 && second.decisionWait);
    assert.equal(second.decisionWait.generation, 2);
    assert.equal(second.workflow.currentStepId, "plan");
    assert.equal(second.workflow.attempt, 2);
    assert.equal(second.decisionWait.plannerSessionId, first.decisionWait.plannerSessionId);
    assert.notEqual(second.decisionWait.checkpointSha256, firstCheckpointSha256);
    assert.equal(
      second.decisionWait.checkpointSha256,
      createHash("sha256")
        .update(readFileSync(join(waiting.runDir, "planner-session.jsonl")))
        .digest("hex"),
    );
    assert.equal(second.decisionWait.plannerSessionSha256, second.decisionWait.checkpointSha256);
    const plannerCalls = exe.calls.filter(
      (call) =>
        call.operation === "execStream" && (call.value as { argv: string[] }).argv.includes("plan"),
    );
    const round2Argv = (plannerCalls[1]!.value as { argv: string[] }).argv;
    assert.ok(round2Argv.includes("--resume-session"));
    assert.equal(round2Argv[round2Argv.indexOf("--session-id") + 1], "planner-session");
    const decisionPhases = readTelemetry(telemetryPath(root, first.runId)).filter(
      (event) => event.type === "phase_started" && event.phase?.name === "awaiting_decision",
    );
    assert.equal(decisionPhases.at(-1)?.phase?.id, "awaiting_decision:2");
    assert.equal(decisionPhases.at(-1)?.phase?.attempt, 2);

    const completed = await runController({
      ...options,
      runId: first.runId,
      resumeExisting: true,
      inlineDecisionWaiter: async (request) => {
        assert.equal(request.generation, 2);
        return {
          commentId: "reply-2",
          body: "Keep it",
          createdAt: "2026-01-02T00:00:00.000Z",
          sha256: "b".repeat(64),
        };
      },
    });
    assert.equal(completed.status, "completed", completed.error);
    const completedState = readControllerState(waiting.runDir);
    assert.equal(completedState.version, 2);
    const finalPlannerCalls = exe.calls.filter(
      (call) =>
        call.operation === "execStream" && (call.value as { argv: string[] }).argv.includes("plan"),
    );
    assert.equal(finalPlannerCalls.length, 3);
    const round3Argv = (finalPlannerCalls[2]!.value as { argv: string[] }).argv;
    assert.ok(round3Argv.includes("--resume-session"));
    assert.equal(round3Argv[round3Argv.indexOf("--session-id") + 1], "planner-session");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller replaces one missing retained VM before resuming", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new MissingRetainedVmExe();
  try {
    const waiting = await runController(controllerOptions(root, exe));
    const runId = readControllerState(waiting.runDir).runId;
    exe.missing = true;
    const result = await runController({
      ...controllerOptions(root, exe),
      runId,
      resumeExisting: true,
      inlineDecisionWaiter: async () => ({
        commentId: "reply-1",
        body: "Keep it",
        createdAt: "2026-01-02T00:00:00.000Z",
        sha256: "a".repeat(64),
      }),
    });
    assert.equal(result.status, "completed", result.error);
    assert.equal(exe.calls.filter((call) => call.operation === "create").length, 2);
    assert.ok(existsSync(join(result.runDir, "decision-vm-replacement.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller binds a Linear decision into fresh intake", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const body = "Keep the sign-in card";
  const commentId = "reply-1";
  const createdAt = "2026-01-02T00:00:00.000Z";
  try {
    const result = await runController({
      ...controllerOptions(root, new FakeExe()),
      runId: "55555555-5555-4555-8555-555555555555",
      decision: {
        previousRunId: "44444444-4444-4444-8444-444444444444",
        requestCommentId: "decision-comment-1",
        commentId,
        body,
        createdAt,
        sha256: createHash("sha256")
          .update(JSON.stringify({ commentId, body, createdAt }))
          .digest("hex"),
      },
    });
    assert.equal(result.status, "completed", result.error);
    assert.match(readFileSync(join(result.runDir, "issue.md"), "utf8"), /Keep the sign-in card/);
    assert.notEqual(readControllerState(result.runDir).idempotencyKey, snapshot.idempotencyKey);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller reaches ready only after remote evidence and VM cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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
      identity: "/tmp/maquila-key",
      timeoutSeconds: 1,
      linearToken,
      githubToken,
      openRouterKey: "openrouter-secret-value",
      root,
      maquilaRoot: testMaquilaRoot(),
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
    assert.equal(state.version, 2);
    if (state.version === 2) {
      assert.equal(state.workflow.currentStepId, "review");
      assert.equal(state.workflow.attempt, 1);
      assert.equal(
        state.workflow.manifestSha256,
        createHash("sha256")
          .update(readFileSync(join(result.runDir, "workflow-manifest.json")))
          .digest("hex"),
      );
    }
    assert.ok(statSync(join(result.runDir, "change.patch")).isFile());
    assert.ok(statSync(join(result.runDir, "evidence-manifest.json")).isFile());
    const workflowManifest = JSON.parse(
      readFileSync(join(result.runDir, "workflow-manifest.json"), "utf8"),
    ) as {
      plannerRunId: string;
      baseSha: string;
      steps: Array<{ id: string; status: string; skipReason?: string }>;
    };
    assert.equal(workflowManifest.plannerRunId, ids[0]);
    assert.equal(workflowManifest.baseSha, BASE_SHA);
    assert.equal(workflowManifest.steps[0]?.id, "implement");
    assert.equal(workflowManifest.steps[0]?.status, "pending");
    assert.ok(
      exe.calls.some(
        (call) =>
          call.operation === "copyTo" &&
          JSON.stringify(call.value).includes("/home/exedev/workflow-manifest.json"),
      ),
    );
    assert.match(JSON.stringify(exe.calls), /--workflow-manifest/);
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
    assert.doesNotMatch(JSON.stringify(exe.calls), /maquila\/\/home\/exedev\/maquila/);
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
    assert.equal(contexts.length, 4);
    assert.ok(contexts.every((event) => /^[0-9a-f]{64}$/.test(event.payload.systemPromptSha256)));
    assert.deepEqual(
      contexts.map((event) => event.payload.model),
      [
        "openrouter/z-ai/glm-5.3",
        "openrouter/google/gemini-3.7-flash",
        "openrouter/google/gemini-3.7-flash",
        "openrouter/google/gemini-3.7-flash",
      ],
    );
    assert.ok(contexts.every((event) => event.payload.executionLimits === undefined));
    assert.ok(
      contexts.every((event) => !("prompt" in event.payload) && !("systemPrompt" in event.payload)),
    );
    assert.deepEqual(
      events.filter((event) => event.type === "agent_usage").map((event) => event.payload.total),
      [14, 2, 2, 5],
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "agent_usage")
        .map((event) => [event.payload.contextTokens, event.payload.contextWindow]),
      [
        [50_000, 200_000],
        [undefined, undefined],
        [undefined, undefined],
        [undefined, undefined],
      ],
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "agent_usage")
        .map((event) => event.payload.referenceEstimateNanoUsd),
      [undefined, undefined, undefined, undefined],
    );
    assert.deepEqual(
      events.filter((event) => event.type === "phase_started").map((event) => event.phase?.name),
      [
        "creating_vm",
        "bootstrapping",
        "planning",
        "implementing",
        "documenting",
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

test("controller clones public repositories without an exe.dev GitHub integration", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new FakeExe();
  try {
    const result = await runController({
      ...controllerOptions(root, exe),
      intake: async () => ({
        ...snapshot,
        repository: { ...snapshot.repository, private: false },
      }),
    });
    assert.equal(result.status, "completed", result.error);
    assert.match(JSON.stringify(exe.calls), /https:\/\/github\.com\/santychuy\/bookbounce\.git/);
    assert.doesNotMatch(JSON.stringify(exe.calls), /github\.int\.exe\.xyz/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller completes docs-only remote lifecycle without a worker run", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new DocsOnlyExe();
  try {
    const result = await runController(controllerOptions(root, exe));
    assert.equal(result.status, "completed", result.error);
    const runs = JSON.parse(
      readFileSync(join(result.runDir, "remote-runs.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(runs.workerRun, undefined);
    assert.equal(runs.documenterRun, `/home/exedev/maquila/.maquila/runs/${ids[2]}`);
    const phases = readTelemetry(telemetryPath(root, readControllerState(result.runDir).runId))
      .filter((event) => event.type === "phase_started")
      .map((event) => event.phase?.name);
    assert.equal(phases.includes("implementing"), false);
    assert.ok(phases.includes("documenting"));
    assert.ok(statSync(join(result.runDir, "evidence-manifest.json")).isFile());
    const workflowManifest = JSON.parse(
      readFileSync(join(result.runDir, "workflow-manifest.json"), "utf8"),
    ) as { steps: Array<{ id: string; status: string; skipReason?: string }> };
    assert.deepEqual(workflowManifest.steps[0], {
      id: "implement",
      actorKind: "agent",
      status: "skipped",
      skipReason: "docs-only",
    });
    assert.match(JSON.stringify(exe.calls), /--workflow-manifest/);
    assert.equal(
      JSON.parse(readFileSync(join(result.runDir, "remote-runs.json"), "utf8")).reviewerRun,
      `/home/exedev/maquila/.maquila/runs/${ids[3]}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful archive selection uses execution run IDs not lifecycle identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new MisleadingLifecycleExe();
  try {
    const result = await runController(controllerOptions(root, exe));
    assert.equal(result.status, "completed", result.error);
    const runs = JSON.parse(
      readFileSync(join(result.runDir, "remote-runs.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(runs.documenterRun, `/home/exedev/maquila/.maquila/runs/${ids[2]}`);
    assert.equal(runs.reviewerRun, `/home/exedev/maquila/.maquila/runs/${ids[3]}`);
    assert.equal(runs.workerRun, `/home/exedev/maquila/.maquila/runs/${ids[1]}`);
    assert.doesNotMatch(JSON.stringify(exe.calls), /lifecycle\.json/);
    const tar = exe.calls.find(
      (call) => call.operation === "exec" && JSON.stringify(call.value).includes("evidence.tar"),
    );
    assert.match(JSON.stringify(tar), new RegExp(ids[2]!));
    assert.doesNotMatch(JSON.stringify(tar), /55555555-5555-4555-8555-555555555555/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller dry-run publication completes without claiming a pull request", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  try {
    const { publish: _publish, ...options } = controllerOptions(root, new FakeExe());
    const result = await runController({ ...options, publicationMode: "dry-run" });
    assert.equal(result.status, "completed", result.error);
    assert.equal(result.pullRequest, undefined);
    assert.equal(result.publicationDryRun?.mode, "dry-run");
    assert.ok(existsSync(join(result.runDir, "publication-dry-run.json")));
    assert.equal(existsSync(join(result.runDir, "publication.json")), false);
    const state = readControllerState(result.runDir);
    assert.equal(state.state, "completed");
    const events = readTelemetry(telemetryPath(root, state.runId));
    assert.equal(
      events.some((event) => event.type === "publication_completed"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication failure preserves evidence and fails after VM cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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
      identity: "/tmp/maquila-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      maquilaRoot: testMaquilaRoot(),
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
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new FakeExe(true);
  try {
    const result = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/maquila-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      maquilaRoot: testMaquilaRoot(),
      exe,
      intake: async () => snapshot,
      sleep: async () => {},
    });
    assert.equal(result.status, "failed");
    const state = readControllerState(result.runDir);
    assert.equal(state.state, "failed");
    assert.equal(state.cleanup, "complete");
    assert.equal(exe.calls.filter((call) => call.operation === "destroy").length, 1);
    const events = readTelemetry(telemetryPath(root, state.runId));
    assert.ok(
      events.some(
        (event) =>
          event.type === "failure" &&
          event.payload.stage === "planning_result" &&
          event.payload.message === "planning: model request failed",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "artifact_available" && event.payload.name === "failure-evidence.tar",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized evidence is deleted before secret scan", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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
      name: "Maquila build",
      matches: (argv: string[]) =>
        argv.some((arg) => arg.endsWith("/bun")) && argv.at(-1) === "build",
      expected: "Maquila build failed",
    },
    {
      name: "OpenRouter readiness",
      matches: (argv: string[]) =>
        argv[0] === "curl" && argv.at(-1) === "https://openrouter.ai/api/v1/models",
      expected: "OpenRouter readiness check failed",
    },
  ];
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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

test("controller exposes safe command diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  class BootstrapFailingExe extends FakeExe {
    override async exec(destination: string, argv: string[], timeoutMs?: number) {
      if (argv[0] === "git" && argv[1] === "clone")
        throw new ExeCommandError("remote command", false, 128);
      return super.exec(destination, argv, timeoutMs);
    }
  }
  try {
    const result = await runController(controllerOptions(root, new BootstrapFailingExe()));
    assert.equal(result.status, "failed");
    const state = readControllerState(result.runDir);
    const failure = readTelemetry(telemetryPath(root, state.runId)).find(
      (event) => event.type === "failure" && event.payload.stage === "bootstrapping",
    );
    assert.ok(failure?.type === "failure");
    assert.equal(
      failure.payload.message,
      "repository clone failed (remote command exited with code 128)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failure evidence unavailability is explicit in telemetry", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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
    assert.match(
      result.error ?? "",
      /lifecycle did not pass|archived workflow execution does not match/,
    );
    assert.equal(exe.calls.filter((call) => call.operation === "destroy").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("next run reconciles cleanup failure before intake", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  try {
    const failedCleanup = new FakeExe(false, true);
    const first = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/maquila-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      maquilaRoot: testMaquilaRoot(),
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
      identity: "/tmp/maquila-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      maquilaRoot: testMaquilaRoot(),
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
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const runId = "44444444-4444-4444-4444-444444444444";
  const runDir = join(root, ".maquila", "controllers", runId);
  try {
    createControllerState(runDir, {
      runId,
      idempotencyKey: "d".repeat(64),
      workflow: {
        id: "feature-pr",
        version: 2,
        definitionSha256: featurePrDefinitionSha256(),
      },
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
      identity: "/tmp/maquila-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      maquilaRoot: testMaquilaRoot(),
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
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new FakeExe(false, false, true);
  try {
    const result = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/maquila-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      maquilaRoot: testMaquilaRoot(),
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
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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
      stepId: "verify",
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
      stepId: "review",
      forbidden: undefined,
    },
  ] as const;
  for (const { exe, phase, forbidden } of cases) {
    const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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
      stepId: "verify",
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
      stepId: "review",
    },
  ] as const;
  for (const { exe, phase } of cases) {
    const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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

test("controller surfaces fixed remote phase causes without raw model detail", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new FakeExe();
  exe.normalFailedDocumenter = true;
  exe.documenterFailure = `documenter blocked: linear-secret-value\u001B]8;;https://evil.example\u0007link${"x".repeat(1200)}`;
  try {
    const result = await runController(controllerOptions(root, exe));
    assert.equal(result.status, "failed");
    assert.equal(result.error, "remote worker lifecycle failed");
    const events = readTelemetry(telemetryPath(root, readControllerState(result.runDir).runId));
    const failure = events.find((event) => event.type === "failure");
    assert.ok(failure?.type === "failure");
    assert.equal(failure.payload.stage, "documenting");
    assert.equal(failure.payload.message, "documenting: agent execution failed");
    assert.doesNotMatch(JSON.stringify(events), /linear-secret-value|evil\.example/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote tool IDs and invalid role tools cannot enter public telemetry", async () => {
  for (const exe of [
    new FakeExe(false, false, false, false, false, false, false, true),
    new FakeExe(false, false, false, false, false, false, false, false, true),
  ]) {
    const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
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

test("controller rejects tools outside active remote agent lifecycle", async () => {
  for (const violation of ["before-start", "after-finish", "finish-with-open-tool"] as const) {
    const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
    const exe = new FakeExe();
    exe.toolLifecycleViolation = violation;
    try {
      const result = await runController(controllerOptions(root, exe));
      assert.equal(result.status, "failed", violation);
      assert.equal(exe.calls.filter((call) => call.operation === "destroy").length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("remote command cannot select a future controller phase", async () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new FakeExe(false, false, false, true);
  try {
    const result = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/maquila-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      maquilaRoot: testMaquilaRoot(),
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
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new FakeExe(false, false, false, false, true);
  try {
    const result = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/maquila-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      maquilaRoot: testMaquilaRoot(),
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
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new FakeExe();
  let appends = 0;
  try {
    const result = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/maquila-key",
      timeoutSeconds: 1,
      linearToken: "linear-secret-value",
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      maquilaRoot: testMaquilaRoot(),
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
  const root = mkdtempSync(join(tmpdir(), "maquila-controller-"));
  const exe = new FakeExe();
  const linearToken = "linear-secret-value";
  try {
    const result = await runController({
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/maquila-key",
      timeoutSeconds: 1,
      linearToken,
      githubToken: "github-secret-value",
      openRouterKey: "openrouter-secret-value",
      root,
      maquilaRoot: testMaquilaRoot(),
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
