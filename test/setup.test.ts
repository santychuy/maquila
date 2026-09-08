import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { installMaquilaSkill, runSetup, SetupCancelled } from "../src/setup.js";

function ready(root: string) {
  return {
    maquilaRoot: root,
    env: {},
    homedir: () => root,
    runDoctor: async () => ({ version: 1 as const, ok: true, checks: [] }),
  };
}
test("setup TTY prints links and prompts only missing references", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-setup-"));
  try {
    const output: string[] = [],
      prompts: string[] = [];
    await runSetup({
      ...ready(root),
      stdinIsTTY: true,
      prompt: async (message) => {
        prompts.push(message);
        return "";
      },
      write: (text) => output.push(text),
    });
    assert.equal(prompts.length, 2);
    assert.match(output.join(""), /https:\/\/linear.app\/settings\/api/);
    assert.match(output.join(""), /https:\/\/openrouter.ai\/settings\/keys/);
    assert.equal(existsSync(resolve(root, ".config/maquila/config.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("setup JSON and non-TTY do not prompt or create empty config", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-setup-"));
  try {
    for (const json of [true, false]) {
      let prompted = false;
      const output: string[] = [];
      await runSetup({
        ...ready(root),
        json,
        stdinIsTTY: false,
        prompt: async () => {
          prompted = true;
          return "";
        },
        write: (text) => output.push(text),
      });
      assert.equal(prompted, false);
      assert.equal(existsSync(resolve(root, ".config/maquila/config.json")), false);
      if (json) assert.equal(output.length, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("setup rejects invalid staged references without writing or exposing them", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-setup-"));
  try {
    await assert.rejects(
      () =>
        runSetup({
          ...ready(root),
          linearTokenReference: "op://Vault/Linear/token",
          openRouterTokenReference: "op://Vault/OpenRouter/token",
          runOp: async (_file, args) => {
            if (args.at(-1)?.includes("OpenRouter")) throw new Error("secret-value");
            return "value";
          },
          write: () => undefined,
        }),
      /could not be read/,
    );
    assert.equal(existsSync(resolve(root, ".config/maquila/config.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("setup persists validated reference and forwards target identity to doctor", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-setup-"));
  try {
    let received: { target?: string; identity?: string } | undefined;
    await runSetup({
      ...ready(root),
      target: "/tmp/repo",
      identity: "/tmp/key",
      linearTokenReference: "op://Vault/Linear/token",
      runOp: async () => "value",
      runDoctor: async (options) => {
        received = options;
        return { version: 1, ok: true, checks: [] };
      },
      write: () => undefined,
    });
    assert.match(
      readFileSync(resolve(root, ".config/maquila/config.json"), "utf8"),
      /op:\/\/Vault\/Linear\/token/,
    );
    assert.deepEqual(received && { target: received.target, identity: received.identity }, {
      target: "/tmp/repo",
      identity: "/tmp/key",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("setup maps interrupted prompt to cancellation", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-setup-"));
  try {
    await assert.rejects(
      () =>
        runSetup({
          ...ready(root),
          stdinIsTTY: true,
          prompt: async () => {
            throw { code: "SIGINT" };
          },
          write: () => undefined,
        }),
      SetupCancelled,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup redacts an existing non-symlink skill destination", () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-setup-"));
  try {
    const destination = resolve(root, ".pi/agent/skills/maquila");
    mkdirSync(resolve(destination, ".."), { recursive: true });
    writeFileSync(destination, "not a symlink");
    assert.throws(
      () => installMaquilaSkill(root, destination),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "maquila skill destination already exists" &&
        !error.message.includes(root),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function managedSkill(root: string): string {
  const source = resolve(root, ".pi/skills/maquila");
  mkdirSync(source, { recursive: true });
  writeFileSync(resolve(source, "SKILL.md"), "managed skill bytes\n");
  return source;
}

test("skill setup copies once and accepts only identical managed contents on repeat", () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-skill-repeat-"));
  try {
    const source = managedSkill(root);
    const destination = resolve(root, ".pi/agent/skills/maquila");
    assert.equal(installMaquilaSkill(root, destination), true);
    assert.equal(lstatSync(destination).isSymbolicLink(), false);
    assert.equal(installMaquilaSkill(root, destination), false);
    assert.equal(
      readFileSync(resolve(destination, "SKILL.md"), "utf8"),
      readFileSync(resolve(source, "SKILL.md"), "utf8"),
    );
    assert.equal(lstatSync(resolve(destination, "SKILL.md")).mode & 0o777, 0o600);
    writeFileSync(resolve(destination, "SKILL.md"), "user content");
    assert.throws(() => installMaquilaSkill(root, destination), /destination differs/);
    assert.equal(readFileSync(resolve(destination, "SKILL.md"), "utf8"), "user content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill setup preserves its legacy link but rejects unrelated links without writing", () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-skill-links-"));
  try {
    const source = managedSkill(root);
    const legacy = resolve(root, "legacy");
    symlinkSync(source, legacy, "dir");
    assert.equal(installMaquilaSkill(root, legacy), false);
    assert.equal(lstatSync(legacy).isSymbolicLink(), true);
    const other = resolve(root, "other");
    mkdirSync(other);
    const unrelated = resolve(root, "unrelated");
    symlinkSync(other, unrelated, "dir");
    assert.throws(() => installMaquilaSkill(root, unrelated), /destination already exists/);
    assert.equal(existsSync(resolve(other, "SKILL.md")), false);
    const dangling = resolve(root, "dangling");
    symlinkSync(resolve(root, "absent"), dangling, "dir");
    assert.throws(() => installMaquilaSkill(root, dangling), /destination already exists/);
    assert.equal(existsSync(resolve(root, "absent")), false);
    const fileLink = resolve(root, "file-link");
    mkdirSync(fileLink);
    symlinkSync(resolve(source, "SKILL.md"), resolve(fileLink, "SKILL.md"));
    assert.throws(() => installMaquilaSkill(root, fileLink), /destination already exists/);
    assert.equal(readFileSync(resolve(source, "SKILL.md"), "utf8"), "managed skill bytes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill setup rejects unrelated directories and missing source without overwriting", () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-skill-unmanaged-"));
  try {
    const destination = resolve(root, "destination");
    assert.throws(() => installMaquilaSkill(root, destination), /source is unavailable/);
    assert.equal(existsSync(destination), false);
    managedSkill(root);
    mkdirSync(destination);
    assert.throws(() => installMaquilaSkill(root, destination), /destination already exists/);
    writeFileSync(resolve(destination, "notes.md"), "unrelated");
    assert.throws(() => installMaquilaSkill(root, destination), /destination already exists/);
    assert.equal(existsSync(resolve(destination, "SKILL.md")), false);
    assert.equal(readFileSync(resolve(destination, "notes.md"), "utf8"), "unrelated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
