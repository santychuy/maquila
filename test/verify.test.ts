import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertCleanBaseline,
  assertSafeRepoPath,
  evaluateGitGate,
  parseVerifyConfig,
  verifyRepository,
} from "../src/verify.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}

function initRepo(commands: string[][] = [["true"]]): string {
  const repo = mkdtempSync(join(tmpdir(), "maquila-verify-"));
  git(repo, "init");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "maquila.verify.json"), JSON.stringify({ commands }));
  writeFileSync(join(repo, "keep.txt"), "keep\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  return repo;
}

test("parseVerifyConfig accepts valid argv commands", () => {
  const config = parseVerifyConfig({
    commands: [
      ["bun", "run", "check"],
      ["node", "-e", "process.exit(0)"],
    ],
  });
  assert.deepEqual(config.commands[0], ["bun", "run", "check"]);
});

test("parseVerifyConfig rejects malformed input", () => {
  assert.throws(() => parseVerifyConfig({ commands: [], extra: true }), /unknown fields/);
  assert.throws(() => parseVerifyConfig({ commands: [] }), /non-empty array/);
  assert.throws(() => parseVerifyConfig({ commands: "bun run check" }), /non-empty array/);
  assert.throws(() => parseVerifyConfig({ commands: [["", "check"]] }), /non-blank/);
  assert.throws(() => parseVerifyConfig({ commands: [[]] }), /non-empty argv/);
  assert.throws(() => parseVerifyConfig({ commands: ["bun run check"] }), /argv array/);
});

test("repository paths reject Git metadata on POSIX and Windows separators", () => {
  assert.throws(() => assertSafeRepoPath(".git/config"), /unsafe path/);
  assert.throws(() => assertSafeRepoPath("nested\\.git\\config"), /unsafe path/);
});

test("verifyRepository records passing and failing command evidence", async () => {
  const passingRepo = initRepo([["node", "-e", "process.stdout.write('ok')"]]);
  const failingRepo = initRepo([["node", "-e", "process.exit(7)"]]);
  try {
    const passingBase = git(passingRepo, "rev-parse", "HEAD");
    writeFileSync(join(passingRepo, "keep.txt"), "changed\n");
    const pass = await verifyRepository({
      repo: passingRepo,
      baseSha: passingBase,
      allowedPaths: ["keep.txt"],
    });
    assert.equal(pass.passed, true);
    assert.equal(pass.commands[0]?.exitCode, 0);
    assert.equal(pass.commands[0]?.stdout, "ok");

    const failingBase = git(failingRepo, "rev-parse", "HEAD");
    writeFileSync(join(failingRepo, "keep.txt"), "changed\n");
    const fail = await verifyRepository({
      repo: failingRepo,
      baseSha: failingBase,
      allowedPaths: ["keep.txt"],
    });
    assert.equal(fail.passed, false);
    assert.equal(fail.commands[0]?.exitCode, 7);
    assert.equal(fail.commands[0]?.timedOut, false);
  } finally {
    rmSync(passingRepo, { recursive: true, force: true });
    rmSync(failingRepo, { recursive: true, force: true });
  }
});

test("verifyRepository uses pinned config and rejects worktree manifest changes", async () => {
  const repo = initRepo();
  try {
    const baseSha = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "keep.txt"), "changed\n");
    writeFileSync(
      join(repo, "maquila.verify.json"),
      JSON.stringify({ commands: [["node", "-e", "process.exit(7)"]] }),
    );
    const result = await verifyRepository({
      repo,
      baseSha,
      allowedPaths: ["keep.txt", "maquila.verify.json"],
    });
    assert.equal(result.commands[0]?.exitCode, 0);
    assert.equal(result.passed, false);
    assert.ok(result.git.unexpectedPaths.includes("maquila.verify.json"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("post-check catches command-created unexpected file", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "keep.txt"), "changed\n");
    git(repo, "checkout", "--", "maquila.verify.json");
    writeFileSync(
      join(repo, "maquila.verify.json"),
      JSON.stringify({
        commands: [["node", "-e", "require('node:fs').writeFileSync('surprise.txt','created')"]],
      }),
    );
    git(repo, "add", "maquila.verify.json");
    git(repo, "commit", "-m", "configure check");
    const newBaseSha = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "keep.txt"), "changed again\n");
    const result = await verifyRepository({
      repo,
      baseSha: newBaseSha,
      allowedPaths: ["keep.txt"],
    });
    assert.equal(result.passed, false);
    assert.ok(result.git.unexpectedPaths.includes("surprise.txt"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("timeout evidence is explicit", async () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, "keep.txt"), "changed\n");
    writeFileSync(
      join(repo, "maquila.verify.json"),
      JSON.stringify({ commands: [["node", "-e", "setTimeout(() => {}, 1000)"]] }),
    );
    git(repo, "add", "maquila.verify.json");
    git(repo, "commit", "-m", "configure timeout");
    const baseSha = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "keep.txt"), "changed again\n");
    const result = await verifyRepository({
      repo,
      baseSha,
      allowedPaths: ["keep.txt"],
      commandTimeoutMs: 10,
    });
    assert.equal(result.commands[0]?.timedOut, true);
    assert.equal(result.commands[0]?.exitCode, null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git gate allows approved paths and rejects unexpected or untracked files", () => {
  const repo = initRepo();
  try {
    const baseSha = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "keep.txt"), "changed\n");
    const allowed = evaluateGitGate(repo, baseSha, ["keep.txt"]);
    assert.equal(allowed.passed, true);

    writeFileSync(join(repo, "surprise.txt"), "nope\n");
    const unexpected = evaluateGitGate(repo, baseSha, ["keep.txt"]);
    assert.equal(unexpected.passed, false);
    assert.ok(unexpected.unexpectedPaths.includes("surprise.txt"));
    assert.match(unexpected.reason ?? "", /unexpected paths/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("clean baseline rejects dirty worktree and non-SHA revisions", () => {
  const repo = initRepo();
  try {
    const baseSha = git(repo, "rev-parse", "HEAD");
    assert.throws(() => assertCleanBaseline(repo, "HEAD"), /40-character Git SHA/);
    writeFileSync(join(repo, "keep.txt"), "dirty\n");
    assert.throws(() => assertCleanBaseline(repo, baseSha), /worktree is not clean/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git gate rejects staged rename source and destination", () => {
  const repo = initRepo();
  try {
    const baseSha = git(repo, "rev-parse", "HEAD");
    git(repo, "mv", "keep.txt", "renamed.txt");
    const result = evaluateGitGate(repo, baseSha, ["renamed.txt"]);
    assert.equal(result.passed, false);
    assert.ok(result.unexpectedPaths.includes("keep.txt"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git gate rejects empty diff and HEAD movement", () => {
  const repo = initRepo();
  try {
    const baseSha = git(repo, "rev-parse", "HEAD");
    const empty = evaluateGitGate(repo, baseSha, ["keep.txt"]);
    assert.equal(empty.passed, false);
    assert.equal(empty.reason, "empty diff");

    writeFileSync(join(repo, "keep.txt"), "changed\n");
    git(repo, "add", "keep.txt");
    git(repo, "commit", "-m", "worker commit");
    const moved = evaluateGitGate(repo, baseSha, ["keep.txt"]);
    assert.equal(moved.passed, false);
    assert.equal(moved.reason, "HEAD moved from recorded base SHA");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
