import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadMaquilaConfig, parseMaquilaConfig, writeMaquilaConfig } from "../src/config.js";

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

test("local API keys persist privately and malformed or ambiguous credentials fail closed", () => {
  const home = tempHome();
  try {
    const config = {
      version: 1 as const,
      linear: { token: "fresh-linear-key" },
      openrouter: { token: "fresh-router-key" },
    };
    const path = writeMaquilaConfig(config, { env: { XDG_CONFIG_HOME: home } });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(resolve(path, "..")).mode & 0o777, 0o700);
    assert.deepEqual(loadMaquilaConfig({ env: { XDG_CONFIG_HOME: home } }), config);
    for (const credential of [
      {},
      { token: "" },
      { token: "has spaces" },
      { token: "line\nbreak" },
      { token: "x".repeat(4097) },
      { token: "secret", tokenReference: "op://Vault/Item/field" },
    ])
      assert.throws(
        () => parseMaquilaConfig(JSON.stringify({ version: 1, linear: credential })),
        /^Error: invalid maquila config$/,
      );
    chmodSync(path, 0o644);
    assert.throws(
      () => loadMaquilaConfig({ env: { XDG_CONFIG_HOME: home } }),
      /^Error: invalid maquila config$/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("credential config refuses linked files on read and linked directories on write", () => {
  const home = tempHome();
  try {
    const path = writeMaquilaConfig({ version: 1 }, { env: { XDG_CONFIG_HOME: home } });
    const other = resolve(home, "other.json");
    writeFileSync(other, '{"version":1}', { mode: 0o600 });
    rmSync(path);
    symlinkSync(other, path);
    assert.throws(
      () => loadMaquilaConfig({ env: { XDG_CONFIG_HOME: home } }),
      /^Error: invalid maquila config$/,
    );
    rmSync(resolve(home, "maquila"), { recursive: true });
    const directory = resolve(home, "unrelated");
    mkdirSync(directory);
    symlinkSync(directory, resolve(home, "maquila"), "dir");
    assert.throws(
      () =>
        writeMaquilaConfig(
          { version: 1, linear: { token: "do-not-write" } },
          { env: { XDG_CONFIG_HOME: home } },
        ),
      /invalid maquila config directory/,
    );
    assert.equal(readFileSync(other, "utf8"), '{"version":1}');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config write refuses a path inside the target repository", () => {
  const home = tempHome();
  const nested = mkdtempSync(resolve(process.cwd(), ".maquila-xdg-test-"));
  try {
    assert.throws(
      () =>
        writeMaquilaConfig(
          { version: 1, linear: { token: "do-not-write" } },
          { env: { XDG_CONFIG_HOME: home }, target: home },
        ),
      /must not be stored in the target repository/,
    );
    assert.equal(loadMaquilaConfig({ env: { XDG_CONFIG_HOME: home } }).linear, undefined);
    assert.throws(
      () =>
        writeMaquilaConfig(
          { version: 1, linear: { token: "do-not-write" } },
          { env: { XDG_CONFIG_HOME: nested } },
        ),
      /must not be stored in the target repository/,
    );
    const link = resolve(home, "via-link");
    symlinkSync(home, link);
    assert.throws(
      () =>
        writeMaquilaConfig(
          { version: 1, linear: { token: "do-not-write" } },
          { env: { XDG_CONFIG_HOME: home }, target: link },
        ),
      /must not be stored in the target repository/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(nested, { recursive: true, force: true });
  }
});

test("unknown fields and raw tokens in reference fields fail closed", () => {
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
