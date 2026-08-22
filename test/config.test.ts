import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadMaquilaConfig, writeMaquilaConfig } from "../src/config.js";

function tempHome(): string {
  return mkdtempSync(resolve(tmpdir(), "maquila-config-"));
}

test("missing config is empty version 1", () => {
  const home = tempHome();
  try {
    assert.deepEqual(loadMaquilaConfig({ env: { XDG_CONFIG_HOME: home } }), { version: 1 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("valid config loads and writes mode 0600", () => {
  const home = tempHome();
  try {
    const path = writeMaquilaConfig(
      {
        version: 1,
        linear: { tokenReference: "op://Vault/Item/field" },
        openrouter: { tokenReference: "op://Vault/OpenRouter/token" },
      },
      { env: { XDG_CONFIG_HOME: home } },
    );
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(resolve(path, "..")).mode & 0o777, 0o700);
    assert.deepEqual(loadMaquilaConfig({ env: { XDG_CONFIG_HOME: home } }), {
      version: 1,
      linear: { tokenReference: "op://Vault/Item/field" },
      openrouter: { tokenReference: "op://Vault/OpenRouter/token" },
    });
    assert.doesNotMatch(readFileSync(path, "utf8"), /lin_|ghp_|sk-or-/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unknown fields and raw tokens fail closed", () => {
  const home = tempHome();
  try {
    const path = resolve(home, "maquila", "config.json");
    writeMaquilaConfig({ version: 1 }, { env: { XDG_CONFIG_HOME: home } });
    writeFileSync(path, JSON.stringify({ version: 1, extra: true }));
    assert.throws(
      () => loadMaquilaConfig({ env: { XDG_CONFIG_HOME: home } }),
      /invalid maquila config/,
    );
    writeFileSync(
      path,
      JSON.stringify({ version: 1, linear: { tokenReference: "lin_secret_token" } }),
    );
    assert.throws(
      () => loadMaquilaConfig({ env: { XDG_CONFIG_HOME: home } }),
      /invalid (?:Linear token reference|maquila config)/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
