import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
