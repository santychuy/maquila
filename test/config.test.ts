import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadFactoryConfig, writeFactoryConfig } from "../src/config.js";

function tempHome(): string {
  return mkdtempSync(resolve(tmpdir(), "factory-config-"));
}

test("missing config is empty version 1", () => {
  const home = tempHome();
  try {
    assert.deepEqual(loadFactoryConfig({ env: { XDG_CONFIG_HOME: home } }), { version: 1 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("valid config loads and writes mode 0600", () => {
  const home = tempHome();
  try {
    const path = writeFactoryConfig(
      { version: 1, linear: { tokenReference: "op://Vault/Item/field" } },
      { env: { XDG_CONFIG_HOME: home } },
    );
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(resolve(path, "..")).mode & 0o777, 0o700);
    assert.deepEqual(loadFactoryConfig({ env: { XDG_CONFIG_HOME: home } }), {
      version: 1,
      linear: { tokenReference: "op://Vault/Item/field" },
    });
    assert.doesNotMatch(readFileSync(path, "utf8"), /lin_|ghp_/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unknown fields and raw tokens fail closed", () => {
  const home = tempHome();
  try {
    const path = resolve(home, "factory", "config.json");
    writeFactoryConfig({ version: 1 }, { env: { XDG_CONFIG_HOME: home } });
    writeFileSync(path, JSON.stringify({ version: 1, extra: true }));
    assert.throws(
      () => loadFactoryConfig({ env: { XDG_CONFIG_HOME: home } }),
      /invalid factory config/,
    );
    writeFileSync(
      path,
      JSON.stringify({ version: 1, linear: { tokenReference: "lin_secret_token" } }),
    );
    assert.throws(
      () => loadFactoryConfig({ env: { XDG_CONFIG_HOME: home } }),
      /invalid (?:Linear token reference|factory config)/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
