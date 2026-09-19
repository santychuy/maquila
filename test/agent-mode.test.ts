import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { detectAgentEnvironment, isAgentMode, renderAgentProgress } from "../src/agent-mode.js";
import type { DoctorResult } from "../src/doctor.js";
import { runSetup } from "../src/setup.js";
import { parseCli } from "../src/cli/parse.js";

function result(checks: DoctorResult["checks"]): DoctorResult {
  return { version: 1, ok: checks.every((item) => item.status !== "fail"), checks };
}
const pass = (id: string) => ({ id, status: "pass" as const, message: `${id} ok` });
const fail = (id: string) => ({
  id,
  status: "fail" as const,
  message: `${id} broken`,
  remediation: `fix ${id}`,
});

test("detectAgentEnvironment finds known agent signals", () => {
  assert.equal(detectAgentEnvironment({}), null);
  assert.equal(detectAgentEnvironment({ PI_CODING_AGENT: "true" }), "PI_CODING_AGENT");
  assert.equal(detectAgentEnvironment({ PI_SESSION_ID: "abc" }), "PI_SESSION_ID");
  assert.equal(detectAgentEnvironment({ CLAUDECODE: "1" }), "CLAUDECODE");
  assert.equal(detectAgentEnvironment({ CURSOR_TRACE_ID: "x" }), "CURSOR_TRACE_ID");
  assert.equal(detectAgentEnvironment({ OPENCODE: "1" }), "OPENCODE");
  assert.equal(detectAgentEnvironment({ CLAUDECODE: "" }), null);
});

test("isAgentMode prefers explicit flag, falls back to environment", () => {
  assert.equal(isAgentMode(true, {}), true);
  assert.equal(isAgentMode(undefined, { AIDER_MODEL: "m" }), true);
  assert.equal(isAgentMode(undefined, {}), false);
});

test("renderAgentProgress separates resolved and pending with machine blocks", () => {
  const text = renderAgentProgress(result([pass("target"), fail("github")]));
  assert.match(text, /# Maquila setup: incomplete/);
  assert.match(text, /## Resolved/);
  assert.match(text, /\*\*target\*\*/);
  assert.match(text, /### github \(required\)/);
  assert.match(text, /"check":"github"/);
  assert.match(text, /GITHUB_TOKEN/);
  const done = renderAgentProgress(result([pass("target")]));
  assert.match(done, /# Maquila setup: complete/);
  const warned = renderAgentProgress(
    result([
      pass("target"),
      { id: "credits", status: "warn", message: "limit resets", remediation: "use a fixed cap" },
    ]),
  );
  assert.match(warned, /# Maquila setup: complete/);
  assert.match(warned, /## Warnings/);
  assert.match(warned, /### credits \(optional\)/);
  assert.doesNotMatch(warned, /### credits \(required\)/);
});

test("setup agent mode writes markdown without prompting on a TTY", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-agent-"));
  try {
    const output: string[] = [];
    let prompted = false;
    const completed = await runSetup({
      maquilaRoot: root,
      env: {},
      homedir: () => root,
      agent: true,
      stdinIsTTY: true,
      prompt: async () => {
        prompted = true;
        return "";
      },
      promptSecret: async () => {
        prompted = true;
        return "must-not-read";
      },
      write: (text) => output.push(text),
      runDoctor: async () => result([pass("target"), fail("github")]),
    });
    assert.equal(prompted, false);
    assert.equal(completed.ok, false);
    assert.match(output.join(""), /## Pending/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup wizard walks steps and rechecks failures", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-wizard-"));
  try {
    const output: string[] = [];
    let calls = 0;
    await runSetup({
      maquilaRoot: root,
      env: { LINEAR_API_TOKEN: "x", OPENROUTER_API_KEY: "y" },
      homedir: () => root,
      stdinIsTTY: true,
      prompt: async () => "",
      write: (text) => output.push(text),
      runDoctor: async () => {
        calls += 1;
        if (calls === 1) return result([pass("target"), fail("github")]);
        return result([pass("target"), pass("github")]);
      },
    });
    const text = output.join("");
    assert.match(text, /Maquila setup — 6 steps/);
    assert.match(text, /Step 2\/6: GitHub access — needs attention/);
    assert.match(text, /Step 2\/6: GitHub access — pass/);
    assert.match(text, /Setup complete/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup wizard skip continues to summary", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-wizard-"));
  try {
    const output: string[] = [];
    await runSetup({
      maquilaRoot: root,
      env: { LINEAR_API_TOKEN: "x", OPENROUTER_API_KEY: "y" },
      homedir: () => root,
      stdinIsTTY: true,
      prompt: async () => "s",
      write: (text) => output.push(text),
      runDoctor: async () => result([fail("github")]),
    });
    assert.match(output.join(""), /Setup incomplete: github/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli parses --agent for setup and doctor, rejects it with --json", () => {
  assert.deepEqual(parseCli(["setup", "--agent"]), {
    command: "setup",
    target: process.cwd(),
    agent: true,
  });
  assert.deepEqual(parseCli(["doctor", "--agent"]), {
    command: "doctor",
    target: process.cwd(),
    agent: true,
  });
  assert.throws(() => parseCli(["setup", "--agent", "--json"]), /--agent cannot be combined/);
  assert.throws(() => parseCli(["doctor", "--agent", "--json"]), /--agent cannot be combined/);
  assert.deepEqual(parseCli(["setup", "--from-scratch"]), {
    command: "setup",
    target: process.cwd(),
    fromScratch: true,
  });
  assert.throws(() => parseCli(["setup", "--from-scratch", "--json"]), /--from-scratch/);
  assert.throws(() => parseCli(["setup", "--from-scratch", "--agent"]), /--from-scratch/);
  assert.throws(
    () => parseCli(["setup", "--from-scratch", "--linear-token-reference", "op://V/I/f"]),
    /--from-scratch/,
  );
  assert.throws(() => parseCli(["doctor", "--from-scratch"]), /unsupported/);
});
