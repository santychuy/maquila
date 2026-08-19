import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { listAgents, loadAgentFile } from "../src/agents.js";
import { agentExitCode, HELP, main, parseCli } from "../src/cli.js";
import { MAX_TIMEOUT_SECONDS } from "../src/plan.js";

test("planner command accepts required inputs and safe timeout", () => {
  assert.deepEqual(
    parseCli([
      "pi",
      "plan",
      "--repo",
      "/tmp/repo",
      "--issue",
      "/tmp/issue.md",
      "--model",
      "anthropic/example",
      "--timeout-seconds",
      "60",
    ]),
    {
      repo: "/tmp/repo",
      issue: "/tmp/issue.md",
      model: "anthropic/example",
      timeoutSeconds: 60,
    },
  );
});

test("controller command accepts bounded immutable inputs", () => {
  assert.deepEqual(
    parseCli([
      "run",
      "--issue",
      "RIFF-39",
      "--owner",
      "santychuy",
      "--repo",
      "bookbounce",
      "--base-ref",
      "main",
      "--tag",
      "santychuy-bookbounce",
      "--identity",
      "/tmp/exe",
      "--timeout-seconds",
      "60",
    ]),
    {
      issue: "RIFF-39",
      owner: "santychuy",
      repo: "bookbounce",
      baseRef: "main",
      tag: "santychuy-bookbounce",
      identity: "/tmp/exe",
      timeoutSeconds: 60,
    },
  );
  assert.match(HELP, /factory run/);
  const defaultTimeout = parseCli([
    "run",
    "--issue",
    "RIFF-39",
    "--owner",
    "santychuy",
    "--repo",
    "bookbounce",
    "--base-ref",
    "main",
    "--tag",
    "santychuy-bookbounce",
    "--identity",
    "/tmp/exe",
  ]);
  assert.equal(typeof defaultTimeout === "object" ? defaultTimeout.timeoutSeconds : 0, 900);
  assert.equal(parseCli(["--", "agents", "list"]), "list-agents");
  assert.throws(() => parseCli(["run"]), /--issue/);
  assert.throws(
    () =>
      parseCli([
        "run",
        "--issue",
        "RIFF-39",
        "--owner",
        "santychuy",
        "--repo",
        "bookbounce",
        "--base-ref",
        "main",
        "--tag",
        "santychuy-bookbounce",
        "--identity",
        "relative-key",
      ]),
    /absolute path/,
  );
  const withoutIdentity = parseCli([
    "run",
    "--issue",
    "RIFF-39",
    "--owner",
    "santychuy",
    "--repo",
    "bookbounce",
    "--base-ref",
    "main",
    "--tag",
    "santychuy-bookbounce",
  ]);
  assert.equal(
    typeof withoutIdentity === "object" && "identity" in withoutIdentity
      ? withoutIdentity.identity
      : undefined,
    undefined,
  );
});

test("detached run and status commands default target to cwd and treat JSON as optional", () => {
  assert.deepEqual(
    parseCli(["run", "start", "--target", "/tmp/target", "--issue", "RIFF-52", "--json"]),
    {
      command: "run-start",
      target: "/tmp/target",
      issue: "RIFF-52",
      timeoutSeconds: 900,
      json: true,
    },
  );
  assert.deepEqual(parseCli(["run", "start", "--issue", "RIFF-52"]), {
    command: "run-start",
    target: process.cwd(),
    issue: "RIFF-52",
    timeoutSeconds: 900,
  });
  assert.deepEqual(
    parseCli(["run", "status", "--run-id", "11111111-1111-4111-8111-111111111111", "--json"]),
    { command: "run-status", runId: "11111111-1111-4111-8111-111111111111", json: true },
  );
  assert.deepEqual(
    parseCli(["run", "status", "--run-id", "11111111-1111-4111-8111-111111111111"]),
    {
      command: "run-status",
      runId: "11111111-1111-4111-8111-111111111111",
    },
  );
  assert.throws(
    () =>
      parseCli([
        "run",
        "status",
        "--run-id",
        "11111111-1111-4111-8111-111111111111",
        "--target",
        "/wrong",
        "--json",
      ]),
    /unsupported option.*--target/,
  );
  const execute = parseCli([
    "run",
    "execute",
    "--run-id",
    "11111111-1111-4111-8111-111111111111",
    "--issue",
    "RIFF-52",
    "--owner",
    "acme",
    "--repo",
    "widget",
    "--base-ref",
    "release/2026-q1",
    "--tag",
    "acme-widget",
  ]);
  assert.equal(typeof execute === "object" && "target" in execute, false);
  assert.match(HELP, /run start/);
  assert.match(HELP, /run status/);
});

test("JSON command errors remain strict and bounded", async () => {
  let output = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  };
  try {
    assert.equal(await main(["run", "start", "--json"]), 1);
  } finally {
    process.stdout.write = write;
  }
  assert.deepEqual(JSON.parse(output), {
    version: 1,
    ok: false,
    error: { code: "command_failed", message: "--issue is required" },
  });
});

test("dashboard is human alias for idempotent observer startup", () => {
  assert.deepEqual(parseCli(["dashboard"]), {
    command: "dashboard",
    port: 4600,
  });
  assert.deepEqual(parseCli(["dashboard", "--port", "4700"]), {
    command: "dashboard",
    port: 4700,
  });
  assert.throws(() => parseCli(["dashboard", "--json"]), /unsupported option/);
  assert.match(HELP, /factory dashboard/);
});

test("observer commands expose explicit server and JSON management contracts", () => {
  assert.deepEqual(parseCli(["observer", "serve"]), {
    command: "observer-serve",
    port: 4600,
  });
  assert.deepEqual(parseCli(["observer", "ensure", "--port", "4700", "--json"]), {
    command: "observer-ensure",
    port: 4700,
  });
  assert.deepEqual(parseCli(["observer", "status", "--json"]), {
    command: "observer-status",
  });
  assert.deepEqual(parseCli(["observer", "stop", "--json"]), {
    command: "observer-stop",
  });
  assert.throws(() => parseCli(["observer", "ensure"]), /requires --json/);
  assert.throws(() => parseCli(["observer", "serve", "--port", "0"]), /--port/);
  assert.throws(
    () => parseCli(["observer", "status", "--json", "--issue", "RIFF-1"]),
    /unsupported option/,
  );
  assert.match(HELP, /observer serve/);
  assert.match(HELP, /observer ensure/);
});

test("machine terminal frames own failed and timed-out process outcomes", () => {
  assert.equal(agentExitCode("failed", true), 0);
  assert.equal(agentExitCode("timed_out", true), 0);
  assert.equal(agentExitCode("failed", false), 1);
  assert.equal(agentExitCode("timed_out", false), 124);
});

test("machine mode is explicit on internal remote commands", () => {
  const parsed = parseCli([
    "pi",
    "plan",
    "--repo",
    "/tmp/repo",
    "--issue",
    "/tmp/issue.md",
    "--model",
    "anthropic/example",
    "--machine",
  ]);
  assert.equal(
    typeof parsed === "object" && "machine" in parsed ? parsed.machine : undefined,
    true,
  );
});

test("worker lifecycle command parses immutable inputs", () => {
  assert.deepEqual(
    parseCli([
      "pi",
      "worker",
      "--repo",
      "/tmp/repo",
      "--issue",
      "/tmp/issue.md",
      "--planner",
      "/tmp/planner.json",
      "--base-sha",
      "a".repeat(40),
      "--model",
      "anthropic/example",
      "--timeout-seconds",
      "60",
    ]),
    {
      repo: "/tmp/repo",
      issue: "/tmp/issue.md",
      plannerEnvelope: "/tmp/planner.json",
      baseSha: "a".repeat(40),
      model: "anthropic/example",
      timeoutSeconds: 60,
    },
  );
  assert.match(HELP, /factory pi worker/);
  assert.throws(() => parseCli(["pi", "worker"]), /--planner/);
  assert.throws(() => parseCli(["unknown"]), /pi worker/);
});

test("planner rejects missing input and timeouts beyond run ceiling", () => {
  assert.throws(() => parseCli(["pi", "plan"]), /required/);
  assert.throws(
    () =>
      parseCli([
        "pi",
        "plan",
        "--repo",
        "/tmp/repo",
        "--issue",
        "/tmp/issue.md",
        "--model",
        "anthropic/example",
        "--timeout-seconds",
        String(MAX_TIMEOUT_SECONDS + 1),
      ]),
    /1 to 1800/,
  );
});

test("specialized agents load with explicit capability boundaries", () => {
  const agents = Object.fromEntries(listAgents().map((agent) => [agent.name, agent]));
  assert.deepEqual(Object.keys(agents), ["planner", "reviewer", "worker"]);
  assert.equal(agents.planner?.access, "read-only");
  assert.deepEqual(agents.planner?.tools, ["read", "grep", "find", "ls"]);
  assert.equal(agents.reviewer?.access, "read-only");
  assert.deepEqual(agents.reviewer?.tools, ["read", "grep", "find", "ls"]);
  assert.equal(agents.worker?.access, "writer");
  assert.deepEqual(agents.worker?.tools, ["read", "grep", "find", "ls", "bash", "edit", "write"]);
  assert.equal(parseCli(["agents", "list"]), "list-agents");
});

test("agent definitions fail closed on schema and access violations", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "factory-agent-"));
  const unknownField = resolve(directory, "unknown-field.md");
  const unsafeReader = resolve(directory, "unsafe-reader.md");
  writeFileSync(
    unknownField,
    "---\nname: unknown-field\ndescription: Bad definition\ntools: [read]\naccess: read-only\ntypo: true\n---\nPrompt\n",
  );
  writeFileSync(
    unsafeReader,
    "---\nname: unsafe-reader\ndescription: Unsafe reader\ntools: [read, write]\naccess: read-only\n---\nPrompt\n",
  );
  try {
    assert.throws(() => loadAgentFile(unknownField), /unknown fields: typo/);
    assert.throws(() => loadAgentFile(unsafeReader), /read-only agent cannot use: write/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
