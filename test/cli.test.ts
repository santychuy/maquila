import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { listAgents, loadAgentFile } from "../src/agents.js";
import { HELP, parseCli } from "../src/cli.js";
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
