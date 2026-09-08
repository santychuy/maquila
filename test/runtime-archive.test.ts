import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { archiveMaquila, readArchivedRole, runtimeArchive } from "../src/runtime-archive.js";
test("packaged runtime works without git", () => {
  const root = mkdtempSync(resolve(tmpdir(), "runtime-fixture-"));
  const install = mkdtempSync(resolve(tmpdir(), "runtime-install-"));
  try {
    mkdirSync(resolve(root, "src/agents"), { recursive: true });
    writeFileSync(
      resolve(root, "src/agents/planner.md"),
      "---\nname: planner\ndescription: test planner\nmodel: openrouter/test/model\ntools: [read]\nthinking: low\naccess: read-only\n---\nTest planner prompt.\n",
    );
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const a = archiveMaquila(root);
    try {
      const out = resolve(install, "dist/runtime");
      mkdirSync(out, { recursive: true });
      cpSync(a.path, resolve(out, "runtime.tar"));
      writeFileSync(
        resolve(out, "runtime.json"),
        JSON.stringify({
          version: 1,
          maquilaSha: a.sha,
          sha256: createHash("sha256").update(readFileSync(a.path)).digest("hex"),
        }),
      );
      const b = runtimeArchive(install);
      try {
        assert.equal(b.sha, a.sha);
        assert.equal(readArchivedRole(b, "planner").name, "planner");
        b.cleanup();
        writeFileSync(
          resolve(out, "runtime.json"),
          JSON.stringify({ version: 1, maquilaSha: a.sha, sha256: "0".repeat(64), unknown: true }),
        );
        assert.throws(() => runtimeArchive(install));
        writeFileSync(
          resolve(out, "runtime.json"),
          JSON.stringify({
            version: 2,
            maquilaSha: a.sha,
            sha256: createHash("sha256").update(readFileSync(a.path)).digest("hex"),
          }),
        );
        assert.throws(() => runtimeArchive(install));
        writeFileSync(
          resolve(out, "runtime.json"),
          JSON.stringify({
            version: 1,
            maquilaSha: a.sha,
            sha256: createHash("sha256").update(readFileSync(a.path)).digest("hex"),
          }),
        );
        const bytes = readFileSync(resolve(out, "runtime.tar"));
        writeFileSync(resolve(out, "runtime.tar"), Buffer.concat([bytes, Buffer.from("x")]));
        assert.throws(() => runtimeArchive(install));
      } finally {
        a.cleanup();
      }
    } finally {
      a.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(install, { recursive: true, force: true });
  }
});
