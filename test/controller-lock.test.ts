import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireControllerLock } from "../src/controller-lock.js";

test("controller lock blocks live owner and replaces dead owner", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-lock-"));
  try {
    const lock = acquireControllerLock(root);
    assert.throws(() => acquireControllerLock(root), /lock is held/);
    lock.release();
    const path = join(root, ".factory", "controller.lock");
    writeFileSync(
      path,
      JSON.stringify({ token: "old", pid: 999_999, startedAt: new Date().toISOString() }),
    );
    acquireControllerLock(root).release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
