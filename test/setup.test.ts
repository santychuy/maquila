import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { runSetup } from "../src/setup.js";

test("setup stores only Linear secret references", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-setup-"));
  try {
    mkdirSync(resolve(root, ".ssh"), { recursive: true });
    writeFileSync(resolve(root, ".ssh", "config"), "Host exe.dev\n");
    const output: string[] = [];
    const result = await runSetup({
      factoryRoot: root,
      env: { XDG_CONFIG_HOME: root, LINEAR_API_TOKEN: "raw-token" },
      homedir: () => root,
      stdinIsTTY: false,
      runGh: async () => ({ ok: true }),
      runOp: async () => ({ ok: true }),
      linearTokenReference: "op://Vault/Linear/token",
      write: (text) => output.push(text),
    });
    assert.equal(result.linear.configured, true);
    assert.equal(result.ssh.available, true);
    const config = readFileSync(resolve(root, "factory/config.json"), "utf8");
    assert.match(config, /op:\/\/Vault\/Linear\/token/);
    assert.doesNotMatch(config, /raw-token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
