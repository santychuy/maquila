import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "../src/agents/index.js";
import {
  createSubmitEnvelopeTool,
  envelopeCorrectionPrompt,
  parseEnvelope,
  renderPlannerPlan,
  type EnvelopeCapture,
  type PlannerEnvelope,
} from "../src/envelope.js";
import { runAgent } from "../src/run-agent.js";
import { createRunArtifacts } from "../src/run-artifacts.js";

const validPlanner = {
  summary: "Add envelope validation to the run loop.",
  evidence: ["src/run-agent.ts has no structured final output"],
  changes: [{ path: "src/envelope.ts", action: "add", rationale: "Validate role envelopes" }],
  verification: ["bun run check"],
  risks: ["Model may ignore the tool"],
  decisionsNeeded: [],
};

const validWorker = {
  implemented: "Added envelope validation",
  changedFiles: ["src/envelope.ts"],
  validation: [{ command: "bun run check", outcome: "pass", detail: "5 tests pass" }],
  openRisks: ["none"],
};

const validDocumenter = {
  outcome: "no_change",
  changedFiles: [],
  detail: "No documentation changes needed",
};

const validReviewer = {
  verdict: "PASS",
  correct: ["Envelope schema matches roles"],
  blockingFindings: [],
  nonBlockingFindings: ["Could trim prompt wording"],
  residualRisks: ["Prompt drift"],
};

test("parseEnvelope accepts valid planner, worker, documenter, and reviewer envelopes", () => {
  const planner = parseEnvelope("planner", validPlanner);
  assert.equal(planner.ok, true);
  if (planner.ok) assert.equal(planner.envelope.summary, validPlanner.summary);

  const worker = parseEnvelope("worker", validWorker);
  assert.equal(worker.ok, true);
  if (worker.ok) assert.equal(worker.envelope.validation[0]?.outcome, "pass");

  const documenter = parseEnvelope("documenter", validDocumenter);
  assert.equal(documenter.ok, true);

  const reviewer = parseEnvelope("reviewer", validReviewer);
  assert.equal(reviewer.ok, true);
  if (reviewer.ok) assert.equal(reviewer.envelope.verdict, "PASS");
});

test("parseEnvelope trims surrounding whitespace from strings", () => {
  const result = parseEnvelope("planner", { ...validPlanner, summary: "  padded summary  " });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.envelope.summary, "padded summary");
});

test("ready planner without changes or verification is invalid", () => {
  const noChanges = parseEnvelope("planner", { ...validPlanner, changes: [] });
  assert.equal(noChanges.ok, false);
  if (!noChanges.ok) assert.ok(noChanges.errors.some((error) => error.startsWith("/changes")));

  const noVerification = parseEnvelope("planner", { ...validPlanner, verification: [] });
  assert.equal(noVerification.ok, false);
  if (!noVerification.ok)
    assert.ok(noVerification.errors.some((error) => error.startsWith("/verification")));

  const neither = parseEnvelope("planner", { ...validPlanner, changes: [], verification: [] });
  assert.equal(neither.ok, false);
  if (!neither.ok) assert.equal(neither.errors.length, 2);
});

test("blocked planner with decisions and no changes or verification is valid", () => {
  const result = parseEnvelope("planner", {
    ...validPlanner,
    changes: [],
    verification: [],
    decisionsNeeded: ["Issue does not name the target module"],
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.envelope.changes, []);
});

test("documenter outcomes have unambiguous changed-file semantics", () => {
  assert.equal(parseEnvelope("documenter", { ...validDocumenter, outcome: "updated" }).ok, false);
  assert.equal(
    parseEnvelope("documenter", { ...validDocumenter, changedFiles: ["docs/a.md"] }).ok,
    false,
  );
  assert.equal(
    parseEnvelope("documenter", {
      outcome: "updated",
      changedFiles: ["docs/a.md"],
      detail: "Updated docs",
    }).ok,
    true,
  );
});

test("reviewer PASS with blocking findings is invalid", () => {
  const result = parseEnvelope("reviewer", {
    ...validReviewer,
    blockingFindings: ["Missing tests"],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((error) => error.startsWith("/blockingFindings")));
});

test("reviewer FAIL without blocking findings is invalid", () => {
  const result = parseEnvelope("reviewer", { ...validReviewer, verdict: "FAIL" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((error) => error.startsWith("/blockingFindings")));
});

test("unknown keys are invalid for every role", () => {
  for (const [role, envelope] of [
    ["planner", validPlanner],
    ["worker", validWorker],
    ["reviewer", validReviewer],
  ] as const) {
    const result = parseEnvelope(role, { ...envelope, surprise: "nope" });
    assert.equal(result.ok, false, role);
    if (!result.ok) assert.ok(result.errors.length > 0, role);
  }
});

test("nested empty strings are invalid", () => {
  const inChange = parseEnvelope("planner", {
    ...validPlanner,
    changes: [{ path: "  ", action: "add", rationale: "ok" }],
  });
  assert.equal(inChange.ok, false);
  if (!inChange.ok) assert.ok(inChange.errors.some((error) => error.includes("/changes/0/path")));

  const inList = parseEnvelope("worker", { ...validWorker, changedFiles: ["src/envelope.ts", ""] });
  assert.equal(inList.ok, false);
  if (!inList.ok) assert.ok(inList.errors.some((error) => error.includes("/changedFiles/1")));

  const blankSummary = parseEnvelope("reviewer", {
    ...validReviewer,
    verdict: "FAIL",
    blockingFindings: ["x"],
    correct: ["\n\t"],
  });
  assert.equal(blankSummary.ok, false);
});

test("missing required fields report structural errors", () => {
  const result = parseEnvelope("worker", { implemented: "done" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) => error.includes("changedFiles")));
    assert.ok(result.errors.some((error) => error.includes("validation")));
  }
});

test("renderPlannerPlan emits the planner Markdown headers", () => {
  const parsed = parseEnvelope("planner", validPlanner);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const plan = renderPlannerPlan(parsed.envelope);
  for (const header of [
    "## Summary",
    "## Evidence",
    "## Changes",
    "## Verification",
    "## Risks",
    "## Decisions Needed",
  ]) {
    assert.ok(plan.includes(header), header);
  }
  assert.ok(plan.includes("- `src/envelope.ts` (add): Validate role envelopes"));

  const blocked: PlannerEnvelope = {
    ...validPlanner,
    changes: [],
    verification: [],
    decisionsNeeded: ["Need scope decision"],
  };
  const blockedPlan = renderPlannerPlan(blocked);
  assert.ok(blockedPlan.includes("- None"));
  assert.ok(blockedPlan.includes("- Need scope decision"));
});

test("envelopeCorrectionPrompt is stable", () => {
  const prompt = envelopeCorrectionPrompt("planner", [
    "/changes: at least one change is required when decisionsNeeded is empty",
  ]);
  assert.equal(
    prompt,
    [
      "Your final envelope was missing or invalid. This run requires exactly one valid planner envelope submitted with the submit_envelope tool as your final action.",
      "Validation errors:",
      "- /changes: at least one change is required when decisionsNeeded is empty",
      "Call submit_envelope exactly once with a corrected envelope. Do not call any other tool.",
    ].join("\n"),
  );
});

test("submit_envelope tool captures the value and terminates the run", async () => {
  const capture: EnvelopeCapture = { calls: 0 };
  const tool = createSubmitEnvelopeTool("planner", capture);
  assert.equal(tool.name, "submit_envelope");

  const result = await tool.execute(
    "call-1",
    validPlanner,
    undefined,
    undefined,
    undefined as unknown as ExtensionContext,
  );
  assert.equal(capture.calls, 1);
  assert.deepEqual(capture.value, validPlanner);
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, { role: "planner" });

  const parsed = parseEnvelope("planner", capture.value);
  assert.equal(parsed.ok, true);
});

const plannerAgent: AgentDefinition = {
  name: "planner",
  description: "Test planner",
  model: "bogus/not-a-model",
  tools: ["read", "grep", "find", "ls"],
  thinking: "medium",
  access: "read-only",
  systemPrompt: "You are a test planner.",
  filePath: "/tmp/planner.md",
};

test("envelope mode fails before the model without correction and receipt advertises submit_envelope", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-envelope-"));
  try {
    const artifacts = createRunArtifacts("issue text", root);
    let completedCalls = 0;
    const result = await runAgent({
      agent: plannerAgent,
      cwd: root,
      timeoutSeconds: 60,
      prompt: "Plan this issue.\n\nissue text",
      artifacts,
      envelopeRole: "planner",
      onCompleted: () => {
        completedCalls += 1;
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.envelope, undefined);
    assert.equal(completedCalls, 0);
    assert.ok(!existsSync(resolve(artifacts.runDir, "envelope.json")));

    const receipt = JSON.parse(
      readFileSync(resolve(artifacts.runDir, "receipt.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(receipt.status, "failed");
    assert.equal("envelope" in receipt, false);
    assert.deepEqual((receipt.agent as { tools: string[] }).tools, [
      "read",
      "grep",
      "find",
      "ls",
      "submit_envelope",
    ]);

    const events = readFileSync(resolve(artifacts.runDir, "events.jsonl"), "utf8");
    assert.ok(
      !events.includes("envelope_invalid"),
      "no correction attempted on setup/transport failure",
    );
    assert.ok(!events.includes("envelope_accepted"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
