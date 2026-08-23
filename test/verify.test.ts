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
  verifyRepository,
} from "../src/verify.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout: 10_000 }).trim();
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "maquila-verify-"));
  git(repo, "init");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "keep.txt"), "keep\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  return repo;
}

function options(repo: string, baseSha: string, commands: string[][]) {
  return { repo, baseSha, allowedPaths: ["keep.txt"], commands };
}

test("repository paths reject Git metadata on POSIX and Windows separators", () => {
  assert.throws(() => assertSafeRepoPath(".git/config"), /unsafe path/);
  assert.throws(() => assertSafeRepoPath("nested\\.git\\config"), /unsafe path/);
});

test("verifyRepository runs manifest-pinned commands without config-file loading", async () => {
  const repo = initRepo();
  try {
    const baseSha = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "keep.txt"), "changed\n");
    writeFileSync(join(repo, "maquila.verify.json"), "not JSON\n");
    const result = await verifyRepository(
      options(repo, baseSha, [["node", "-e", "process.stdout.write('ok')"]]),
    );
    assert.equal(result.passed, false);
    assert.equal(result.commands[0]?.exitCode, 0);
    assert.equal(result.commands[0]?.stdout, "ok");
    assert.ok(result.git.unexpectedPaths.includes("maquila.verify.json"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("verifyRepository records failing command evidence", async () => {
  const repo = initRepo();
  try {
    const baseSha = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "keep.txt"), "changed\n");
    const result = await verifyRepository(
      options(repo, baseSha, [["node", "-e", "process.exit(7)"]]),
    );
    assert.equal(result.passed, false);
    assert.equal(result.commands[0]?.exitCode, 7);
    assert.equal(result.commands[0]?.timedOut, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("post-check catches command-created unexpected file", async () => {
  const repo = initRepo();
  try {
    const baseSha = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "keep.txt"), "changed\n");
    const result = await verifyRepository(
      options(repo, baseSha, [
        ["node", "-e", "require('node:fs').writeFileSync('surprise.txt','created')"],
      ]),
    );
    assert.equal(result.passed, false);
    assert.ok(result.git.unexpectedPaths.includes("surprise.txt"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("timeout evidence is explicit", async () => {
  const repo = initRepo();
  try {
    const baseSha = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "keep.txt"), "changed\n");
    const result = await verifyRepository({
      ...options(repo, baseSha, [["node", "-e", "setTimeout(() => {}, 1000)"]]),
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
    assert.equal(evaluateGitGate(repo, baseSha, ["keep.txt"]).passed, true);
    writeFileSync(join(repo, "surprise.txt"), "nope\n");
    const unexpected = evaluateGitGate(repo, baseSha, ["keep.txt"]);
    assert.equal(unexpected.passed, false);
    assert.ok(unexpected.unexpectedPaths.includes("surprise.txt"));
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

test("git gate rejects staged rename source and destination, empty diff, and HEAD movement", () => {
  const repo = initRepo();
  try {
    const baseSha = git(repo, "rev-parse", "HEAD");
    assert.equal(evaluateGitGate(repo, baseSha, ["keep.txt"]).reason, "empty diff");
    git(repo, "mv", "keep.txt", "renamed.txt");
    assert.ok(evaluateGitGate(repo, baseSha, ["renamed.txt"]).unexpectedPaths.includes("keep.txt"));
    git(repo, "commit", "-m", "worker commit");
    assert.equal(
      evaluateGitGate(repo, baseSha, ["renamed.txt"]).reason,
      "HEAD moved from recorded base SHA",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
