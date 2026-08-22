import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { runSetup } from "../src/setup.js";

test("setup preserves existing references when storing OpenRouter reference", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-setup-openrouter-"));
  try {
    mkdirSync(resolve(root, "maquila"), { recursive: true });
    writeFileSync(
      resolve(root, "maquila/config.json"),
      '{"version":1,"linear":{"tokenReference":"op://Vault/Linear/token"}}\n',
    );
    const result = await runSetup({
      maquilaRoot: root,
      env: { XDG_CONFIG_HOME: root },
      homedir: () => root,
      stdinIsTTY: false,
      runGh: async () => ({ ok: true }),
      runOp: async () => ({ ok: true }),
      openRouterTokenReference: "op://Vault/OpenRouter/token",
      write: () => undefined,
    });
    assert.equal(result.openrouter.configured, true);
    assert.match(readFileSync(resolve(root, "maquila/config.json"), "utf8"), /Vault\/Linear/);
    assert.match(readFileSync(resolve(root, "maquila/config.json"), "utf8"), /Vault\/OpenRouter/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup stores only Linear secret references", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-setup-"));
  try {
    mkdirSync(resolve(root, ".ssh"), { recursive: true });
    writeFileSync(resolve(root, ".ssh", "config"), "Host exe.dev\n");
    const output: string[] = [];
    const result = await runSetup({
      maquilaRoot: root,
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
    const config = readFileSync(resolve(root, "maquila/config.json"), "utf8");
    assert.match(config, /op:\/\/Vault\/Linear\/token/);
    assert.doesNotMatch(config, /raw-token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
