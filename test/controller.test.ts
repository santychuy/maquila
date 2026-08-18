import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { harvest, runController, type ControllerExe } from "../src/controller.js";
import { readControllerState } from "../src/run-state.js";

const ids = [
  "11111111-1111-1111-1111-111111111111",
  "22222222-2222-2222-2222-222222222222",
  "33333333-3333-3333-3333-333333333333",
];
function file(root: string, run: string, name: string, value = "{}") {
  const path = join(root, ".factory", "runs", run, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, value);
}
function validArchive(root: string, unsafeLink = false): string {
  file(root, ids[0]!, "receipt.json");
  file(
    root,
    ids[0]!,
    "envelope.json",
    JSON.stringify({
      summary: "Document architecture assessment",
      evidence: ["RIFF-39 requests documentation"],
      changes: [
        {
          path: "docs/architecture-assessment.md",
          action: "add",
          rationale: "Document assessment",
        },
      ],
      verification: ["Run bun run validate"],
      risks: [],
      decisionsNeeded: [],
    }),
  );
  file(root, ids[0]!, "plan.md", "plan");
  file(root, ids[1]!, "receipt.json");
  file(root, ids[1]!, "lifecycle.json", '{"status":"completed"}');
  file(root, ids[1]!, "verification.json", '{"passed":true}');
  file(root, ids[2]!, "receipt.json");
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
  if (unsafeLink) {
    symlinkSync("/tmp", join(root, ".factory", "runs", ids[0]!, "unsafe-link"));
  }
  const archive = join(root, "evidence.tar");
  execFileSync("tar", ["-cf", archive, "-C", root, ".factory/runs"]);
  return archive;
}
test("harvest validates evidence requirements", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  try {
    harvest(validArchive(root), join(root, "out"), ids);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("harvest rejects traversal run identifiers", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  try {
    assert.throws(
      () => harvest(validArchive(root), join(root, "out"), ["../bad", ids[1]!, ids[2]!]),
      /unsafe remote run id/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("harvest rejects symbolic links", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  try {
    assert.throws(() => harvest(validArchive(root, true), join(root, "out"), ids), /unsafe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class FakeExe implements ControllerExe {
  readonly calls: Array<{ operation: string; value: unknown }> = [];

  constructor(
    private readonly failPlanner = false,
    private readonly failDestroy = false,
  ) {}

  async createVm(options: { name: string; tag: string }) {
    this.calls.push({ operation: "create", value: options });
    return { vmName: options.name, status: "creating", sshDest: `${options.name}.exe.xyz` };
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
              path: "docs/architecture-assessment.md",
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
    if (argv.includes("diff"))
      return { stdout: "diff --git a/docs/a.md b/docs/a.md\n", stderr: "" };
    return { stdout: "", stderr: "" };
  }

  async copyTo(destination: string, localPath: string, remotePath: string) {
    this.calls.push({ operation: "copyTo", value: { destination, localPath, remotePath } });
  }

  async copyFrom(destination: string, remotePath: string, localPath: string) {
    this.calls.push({ operation: "copyFrom", value: { destination, remotePath, localPath } });
    const source = mkdtempSync(join(tmpdir(), "factory-remote-evidence-"));
    try {
      copyFileSync(validArchive(source), localPath);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  }
}

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
      root,
      factoryRoot: process.cwd(),
      exe,
      intake: async () => snapshot,
      sleep: async () => {},
    });
    assert.equal(result.status, "ready_for_publication", result.error);
    const state = readControllerState(result.runDir);
    assert.equal(state.state, "ready_for_publication");
    assert.equal(state.cleanup, "complete");
    assert.ok(statSync(join(result.runDir, "change.patch")).isFile());
    assert.ok(statSync(join(result.runDir, "evidence-manifest.json")).isFile());
    assert.match(
      JSON.stringify(exe.calls),
      /https:\/\/github\.int\.exe\.xyz\/santychuy\/bookbounce\.git/,
    );
    assert.doesNotMatch(JSON.stringify(exe.calls), new RegExp(`${linearToken}|${githubToken}`));
    assert.doesNotMatch(JSON.stringify(exe.calls), /factory\/\/home\/exedev\/factory/);
    assert.equal(contains(root, linearToken), false);
    assert.equal(contains(root, githubToken), false);
    assert.deepEqual(exe.calls.filter((call) => call.operation === "destroy").length, 1);
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
      root,
      factoryRoot: process.cwd(),
      exe,
      intake: async () => snapshot,
      sleep: async () => {},
    });
    assert.equal(result.status, "failed");
    const state = readControllerState(result.runDir);
    assert.equal(state.state, "failed");
    assert.equal(state.cleanup, "complete");
    assert.equal(exe.calls.filter((call) => call.operation === "destroy").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("next run reconciles cleanup failure before intake", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-controller-"));
  try {
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
      root,
      factoryRoot: process.cwd(),
      exe: new FakeExe(false, true),
      intake: async () => snapshot,
      sleep: async () => {},
    });
    assert.equal(first.status, "failed");
    assert.equal(readControllerState(first.runDir).cleanup, "failed");

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
      root,
      factoryRoot: process.cwd(),
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
      root,
      factoryRoot: process.cwd(),
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
