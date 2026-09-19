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
import { writeMaquilaConfig } from "../src/config.js";
import type { DoctorOptions, DoctorResult } from "../src/doctor.js";
import { installMaquilaSkill, runSetup, SetupCancelled } from "../src/setup.js";

function nextAnswer(answers: string[]): string {
  assert.ok(answers.length, "setup prompt queue exhausted");
  const value = answers.shift();
  assert.ok(value !== undefined);
  return value;
}
function ready(root: string) {
  return {
    maquilaRoot: root,
    env: {},
    homedir: () => root,
    runDoctor: async () => ({ version: 1 as const, ok: true, checks: [] }),
  };
}
async function chosenDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const env = options.env ?? {};
  const config = options.loadConfig
    ? options.loadConfig({ env, homedir: options.homedir })
    : { version: 1 as const };
  let github = Boolean(env.GITHUB_TOKEN || env.GH_TOKEN);
  if (options.resolveGithub)
    try {
      await options.resolveGithub(env);
      github = true;
    } catch {
      github = false;
    }
  let ssh = Boolean(env.MAQUILA_EXE_IDENTITY);
  if (options.listVms)
    try {
      await options.listVms(options.identity, env);
      ssh = true;
    } catch {
      ssh = false;
    }
  const linear = Boolean(env.LINEAR_API_TOKEN || config.linear);
  const openrouter = Boolean(env.OPENROUTER_API_KEY || config.openrouter);
  const checks = [
    { id: "github", status: github ? ("pass" as const) : ("fail" as const), message: "github" },
    { id: "linear", status: linear ? ("pass" as const) : ("fail" as const), message: "linear" },
    {
      id: "openrouter",
      status: openrouter ? ("pass" as const) : ("fail" as const),
      message: "openrouter",
    },
    { id: "ssh", status: ssh ? ("pass" as const) : ("fail" as const), message: "ssh" },
  ];
  return { version: 1, ok: checks.every((item) => item.status !== "fail"), checks };
}

test("configured setup TTY uses readiness checks without reentering keys", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-setup-"));
  try {
    const output: string[] = [],
      prompts: string[] = [];
    await runSetup({
      ...ready(root),
      env: { LINEAR_API_TOKEN: "existing", OPENROUTER_API_KEY: "existing" },
      stdinIsTTY: true,
      prompt: async (message) => {
        prompts.push(message);
        return "";
      },
      write: (text) => output.push(text),
    });
    assert.equal(prompts.length, 0);
    assert.match(output.join(""), /Maquila setup — 6 steps/);
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
          runDoctor: async () => ({
            version: 1 as const,
            ok: false,
            checks: [{ id: "github", status: "fail" as const, message: "missing" }],
          }),
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
test("setup from scratch walks stations and saves only chosen references", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-scratch-"));
  try {
    const output: string[] = [];
    const answers = ["2", "3", "op://Vault/Linear/token", "4", "2", "n", "y"];
    const completed = await runSetup({
      ...ready(root),
      env: {},
      fromScratch: true,
      stdinIsTTY: true,
      prompt: async () => nextAnswer(answers),
      write: (text) => output.push(text),
      runOp: async () => "tok-123",
      runDoctor: chosenDoctor,
    });
    const text = output.join("");
    assert.match(text, /from scratch — 5 stations/);
    assert.match(text, /Station 1\/5: GitHub/);
    assert.match(text, /Station 5\/5/);
    assert.match(text, /Skipped stations: GitHub, OpenRouter, exe.dev SSH/);
    assert.match(text, /Setup incomplete/);
    assert.equal(completed.ok, false);
    const saved = readFileSync(resolve(root, ".config/maquila/config.json"), "utf8");
    assert.match(saved, /op:\/\/Vault\/Linear\/token/);
    assert.equal(saved.includes("tok-123"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("setup from scratch env choice and skips report without saving", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-scratch-"));
  try {
    const output: string[] = [];
    const answers = ["2", "2", "4", "2", "n"];
    const completed = await runSetup({
      ...ready(root),
      env: { LINEAR_API_TOKEN: "env-token" },
      fromScratch: true,
      stdinIsTTY: true,
      prompt: async () => nextAnswer(answers),
      write: (text) => output.push(text),
      runDoctor: chosenDoctor,
    });
    assert.match(output.join(""), /Skipped stations: GitHub, OpenRouter, exe.dev SSH/);
    assert.equal(completed.ok, false);
    assert.equal(existsSync(resolve(root, ".config/maquila/config.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("setup from scratch preserves unrelated config and ignores env when validating a reference", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-scratch-"));
  try {
    writeMaquilaConfig(
      { version: 1, openrouter: { tokenReference: "op://Vault/OpenRouter/api-key" } },
      { env: {}, homedir: () => root },
    );
    const answers = ["2", "3", "op://Vault/Linear/token", "4", "2", "n", "y"];
    let opArgs: string[] | undefined;
    await runSetup({
      ...ready(root),
      env: { LINEAR_API_TOKEN: "env-token" },
      fromScratch: true,
      stdinIsTTY: true,
      prompt: async () => nextAnswer(answers),
      write: () => undefined,
      runOp: async (_file, args) => {
        opArgs = args;
        return "tok-123";
      },
      runDoctor: chosenDoctor,
    });
    const saved = JSON.parse(readFileSync(resolve(root, ".config/maquila/config.json"), "utf8"));
    assert.equal(saved.linear.tokenReference, "op://Vault/Linear/token");
    assert.equal(saved.openrouter.tokenReference, "op://Vault/OpenRouter/api-key");
    assert.ok(opArgs?.includes("op://Vault/Linear/token"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("setup from scratch does not use skipped preconfigured credentials", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-scratch-"));
  try {
    writeMaquilaConfig(
      {
        version: 1,
        linear: { tokenReference: "op://Vault/Linear/token" },
        openrouter: { tokenReference: "op://Vault/OpenRouter/api-key" },
      },
      { env: {}, homedir: () => root },
    );
    const answers = ["2", "4", "4", "2", "n"];
    let doctorEnv: NodeJS.ProcessEnv | undefined;
    let doctorConfig: { linear?: unknown; openrouter?: unknown } | undefined;
    const completed = await runSetup({
      ...ready(root),
      env: {
        LINEAR_API_TOKEN: "env-token",
        OPENROUTER_API_KEY: "or-token",
        GITHUB_TOKEN: "gh-token",
      },
      fromScratch: true,
      stdinIsTTY: true,
      prompt: async () => nextAnswer(answers),
      write: () => undefined,
      runDoctor: async (options) => {
        doctorEnv = options.env;
        doctorConfig = options.loadConfig?.({ env: options.env ?? {}, homedir: options.homedir });
        return chosenDoctor(options);
      },
    });
    assert.equal(completed.ok, false);
    assert.equal(doctorEnv?.LINEAR_API_TOKEN, undefined);
    assert.equal(doctorEnv?.OPENROUTER_API_KEY, undefined);
    assert.equal(doctorEnv?.GITHUB_TOKEN, undefined);
    assert.equal(doctorConfig?.linear, undefined);
    assert.equal(doctorConfig?.openrouter, undefined);
    const saved = JSON.parse(readFileSync(resolve(root, ".config/maquila/config.json"), "utf8"));
    assert.equal(saved.linear.tokenReference, "op://Vault/Linear/token");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("setup --install-skill on a TTY still runs guided checks", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-setup-"));
  try {
    const source = resolve(root, ".pi/skills/maquila");
    mkdirSync(source, { recursive: true });
    writeFileSync(resolve(source, "SKILL.md"), "skill\n");
    const output: string[] = [];
    let calls = 0;
    await runSetup({
      ...ready(root),
      maquilaRoot: root,
      env: { LINEAR_API_TOKEN: "existing", OPENROUTER_API_KEY: "existing" },
      installSkill: true,
      stdinIsTTY: true,
      prompt: async () => "",
      write: (text) => output.push(text),
      runDoctor: async () => {
        calls += 1;
        if (calls === 1)
          return {
            version: 1 as const,
            ok: false,
            checks: [{ id: "github", status: "fail" as const, message: "missing" }],
          };
        return {
          version: 1 as const,
          ok: true,
          checks: [{ id: "github", status: "pass" as const, message: "ok" }],
        };
      },
    });
    assert.match(output.join(""), /Maquila setup — 6 steps/);
    assert.equal(existsSync(resolve(root, ".pi/agent/skills/maquila/SKILL.md")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("setup --install-skill with --json does not prompt", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-setup-"));
  try {
    const source = resolve(root, ".pi/skills/maquila");
    mkdirSync(source, { recursive: true });
    writeFileSync(resolve(source, "SKILL.md"), "skill\n");
    let prompted = false;
    await runSetup({
      ...ready(root),
      installSkill: true,
      json: true,
      stdinIsTTY: true,
      prompt: async () => {
        prompted = true;
        return "";
      },
      write: () => undefined,
    });
    assert.equal(prompted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("scratch station rechecks cannot resolve unrelated credentials", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-scratch-"));
  try {
    const answers = ["1", "4", "4", "1", "n"];
    let calls = 0;
    await runSetup({
      ...ready(root),
      fromScratch: true,
      stdinIsTTY: true,
      env: { LINEAR_API_TOKEN: "unused", OPENROUTER_API_KEY: "unused" },
      prompt: async () => {
        assert.ok(answers.length);
        return nextAnswer(answers);
      },
      write: () => undefined,
      runDoctor: async (options) => {
        calls++;
        if (calls <= 2) {
          assert.deepEqual(options.loadConfig?.(), { version: 1 });
          assert.ok(options.resolveLinear);
          assert.ok(options.resolveOpenRouter);
          await assert.rejects(() => options.resolveLinear!(options.env ?? {}, undefined));
          await assert.rejects(() => options.resolveOpenRouter!(options.env ?? {}, undefined));
          if (calls === 1) {
            assert.ok(options.listVms);
            await assert.rejects(() => options.listVms!(undefined, options.env ?? {}));
          } else {
            assert.ok(options.resolveGithub);
            await assert.rejects(() => options.resolveGithub!(options.env ?? {}));
          }
          return {
            version: 1,
            ok: false,
            checks: [{ id: calls === 1 ? "github" : "ssh", status: "pass", message: "selected" }],
          };
        }
        return chosenDoctor(options);
      },
    });
    assert.equal(calls, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("scratch declining reference save stays incomplete and preserves config", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-scratch-"));
  try {
    const config = { version: 1 as const, linear: { tokenReference: "op://Vault/Old/token" } };
    writeMaquilaConfig(config, { env: {}, homedir: () => root });
    const answers = ["1", "3", "op://Vault/New/token", "2", "1", "n", "n"];
    const output: string[] = [];
    const result = await runSetup({
      ...ready(root),
      fromScratch: true,
      stdinIsTTY: true,
      env: { GITHUB_TOKEN: "github", OPENROUTER_API_KEY: "router", MAQUILA_EXE_IDENTITY: "/key" },
      prompt: async () => {
        assert.ok(answers.length);
        return nextAnswer(answers);
      },
      runOp: async () => "new-token",
      runDoctor: chosenDoctor,
      write: (text) => output.push(text),
    });
    assert.equal(result.ok, false);
    assert.match(output.join(""), /Credentials not saved/);
    assert.doesNotMatch(output.join(""), /Setup complete\./);
    assert.deepEqual(
      JSON.parse(readFileSync(resolve(root, ".config/maquila/config.json"), "utf8")),
      config,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("scratch shows workspace identity and budget warnings before reporting readiness", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-scratch-"));
  try {
    const answers = ["1", "2", "2", "1", "n"];
    const output: string[] = [];
    const result = await runSetup({
      ...ready(root),
      fromScratch: true,
      stdinIsTTY: true,
      env: { LINEAR_API_TOKEN: "linear", OPENROUTER_API_KEY: "router" },
      prompt: async () => {
        assert.ok(answers.length);
        return nextAnswer(answers);
      },
      write: (text) => output.push(text),
      runDoctor: async () => ({
        version: 1,
        ok: true,
        checks: [
          { id: "github", status: "pass", message: "ready" },
          { id: "ssh", status: "pass", message: "ready" },
          { id: "workspace", status: "pass", message: "Personal workspace" },
          { id: "credits", status: "warn", message: "limit resets weekly; BYOK excluded" },
        ],
      }),
    });
    assert.equal(result.ok, true);
    assert.match(output.join(""), /workspace: pass — Personal workspace/);
    assert.match(output.join(""), /credits: warn — limit resets weekly; BYOK excluded/);
    assert.match(output.join(""), /Setup checks passed with warnings/);
    assert.doesNotMatch(output.join(""), /Setup complete\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("setup JSON preserves safe doctor identity and credit metadata", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-setup-"));
  try {
    const doctor: DoctorResult = {
      version: 1,
      ok: true,
      checks: [],
      linearIdentity: {
        user: { id: "user", name: "Alice" },
        workspace: { id: "workspace", name: "Personal", urlKey: "personal" },
      },
      openRouterKey: {
        limit: 10,
        limitRemaining: 10,
        limitReset: null,
        usage: 0,
        includeByokInLimit: true,
      },
    };
    const output: string[] = [];
    await runSetup({
      ...ready(root),
      json: true,
      runDoctor: async () => doctor,
      write: (text) => output.push(text),
    });
    assert.deepEqual(JSON.parse(output.join("")), { ...doctor, version: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("setup paste saves Linear key without echoing it and skips 1Password", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-scratch-"));
  try {
    const output: string[] = [];
    const answers = ["2", "1", "4", "2", "n", "y"];
    const secret = "lin_pasted_secret_key";
    let secrets = 0;
    const completed = await runSetup({
      ...ready(root),
      fromScratch: true,
      stdinIsTTY: true,
      prompt: async () => nextAnswer(answers),
      promptSecret: async () => {
        secrets += 1;
        return secret;
      },
      write: (text) => output.push(text),
      runOp: async () => {
        throw new Error("1Password must not run");
      },
      runDoctor: chosenDoctor,
    });
    const text = output.join("");
    assert.equal(secrets, 1);
    assert.match(text, /Paste a new API key/);
    assert.match(text, /Key captured without echo/);
    assert.doesNotMatch(text, new RegExp(secret));
    assert.equal(JSON.stringify(completed).includes(secret), false);
    const saved = JSON.parse(readFileSync(resolve(root, ".config/maquila/config.json"), "utf8"));
    assert.equal(saved.linear.token, secret);
    assert.equal(saved.openrouter, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("setup paste decline and cancel never persist the key", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-scratch-"));
  try {
    const secret = "lin_unsaved_secret_key";
    const answers = ["2", "1", "4", "2", "n", "n"];
    const declined = await runSetup({
      ...ready(root),
      fromScratch: true,
      stdinIsTTY: true,
      prompt: async () => nextAnswer(answers),
      promptSecret: async () => secret,
      write: (text) => {
        assert.equal(text.includes(secret), false);
      },
      runDoctor: chosenDoctor,
    });
    assert.equal(declined.ok, false);
    assert.equal(existsSync(resolve(root, ".config/maquila/config.json")), false);
    const cancel = ["2", "1"];
    await assert.rejects(
      () =>
        runSetup({
          ...ready(root),
          fromScratch: true,
          stdinIsTTY: true,
          prompt: async () => nextAnswer(cancel),
          promptSecret: async () => {
            throw new SetupCancelled();
          },
          write: () => undefined,
          runDoctor: chosenDoctor,
        }),
      SetupCancelled,
    );
    assert.equal(existsSync(resolve(root, ".config/maquila/config.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("json and agent setup never prompt for a pasted key", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-scratch-"));
  try {
    for (const extra of [{ json: true as const }, { agent: true as const }]) {
      let secret = false;
      await runSetup({
        ...ready(root),
        ...extra,
        stdinIsTTY: true,
        prompt: async () => {
          throw new Error("must not prompt");
        },
        promptSecret: async () => {
          secret = true;
          return "must-not-read";
        },
        write: () => undefined,
      });
      assert.equal(secret, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("setup from scratch requires a terminal and rejects machine combos", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-scratch-"));
  try {
    await assert.rejects(
      () =>
        runSetup({
          ...ready(root),
          fromScratch: true,
          stdinIsTTY: false,
          write: () => undefined,
        }),
      /interactive terminal/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("TTY with missing credentials enters paste onboarding without --from-scratch", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-scratch-"));
  try {
    const output: string[] = [];
    const answers = ["2", "1", "4", "2", "n", "y"];
    const secret = "lin_first_run_secret";
    await runSetup({
      ...ready(root),
      stdinIsTTY: true,
      prompt: async () => nextAnswer(answers),
      promptSecret: async () => secret,
      write: (text) => output.push(text),
      runDoctor: chosenDoctor,
    });
    assert.match(output.join(""), /Paste a new API key/);
    assert.doesNotMatch(output.join(""), new RegExp(secret));
    assert.equal(
      JSON.parse(readFileSync(resolve(root, ".config/maquila/config.json"), "utf8")).linear.token,
      secret,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("paste save without target refuses XDG inside the current directory", async () => {
  const nested = mkdtempSync(resolve(process.cwd(), ".maquila-xdg-test-"));
  try {
    const answers = ["2", "1", "4", "2", "n", "y"];
    await assert.rejects(
      () =>
        runSetup({
          maquilaRoot: nested,
          env: { XDG_CONFIG_HOME: nested },
          homedir: () => nested,
          fromScratch: true,
          stdinIsTTY: true,
          prompt: async () => nextAnswer(answers),
          promptSecret: async () => "lin_inside_repo_secret",
          write: () => undefined,
          runDoctor: chosenDoctor,
        }),
      /must not be stored in the target repository|could not be written/,
    );
    assert.equal(existsSync(resolve(nested, "maquila/config.json")), false);
  } finally {
    rmSync(nested, { recursive: true, force: true });
  }
});
