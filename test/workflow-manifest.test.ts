import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PlannerEnvelope } from "../src/envelope.js";
import { FEATURE_PR_BLOCKS } from "../src/workflows/feature-pr.js";
import {
  LOCAL_PLANNER_RUN_ID,
  assertFeaturePrManifest,
  createFeaturePrManifest,
  featurePrDefinition,
  featurePrDefinitionSha256,
  parseWorkflowManifest,
  plannerRunIdFromEnvelopePath,
  readWorkflowManifest,
} from "../src/workflows/manifest.js";

const PLANNER_RUN_ID = "11111111-1111-1111-1111-111111111111";
const BASE_SHA = "a".repeat(40);

function plan(paths: string[]): PlannerEnvelope {
  return {
    summary: "Plan",
    evidence: ["Issue"],
    changes: paths.map((path) => ({ path, action: "modify", rationale: "Needed" })),
    verification: ["bun run check"],
    risks: [],
    decisionsNeeded: [],
  };
}

test("manifests pin actor kinds and bun run check", () => {
  const mixed = createFeaturePrManifest({
    plannerRunId: PLANNER_RUN_ID,
    baseSha: BASE_SHA,
    plan: plan(["src/x.ts", "docs/guide.md"]),
  });
  assert.equal(mixed.version, 2);
  assert.equal(mixed.workflowId, "feature-pr");
  assert.equal(mixed.definitionSha256, featurePrDefinitionSha256());
  assert.deepEqual(featurePrDefinition(), {
    id: "feature-pr",
    version: 2,
    postPlanSteps: [
      { id: "implement", phase: "implementing", actor: "worker", actorKind: "agent" },
      { id: "document", phase: "documenting", actor: "documenter", actorKind: "agent" },
      { id: "verify", phase: "verifying", actor: "verifier", actorKind: "code" },
      { id: "review", phase: "reviewing", actor: "reviewer", actorKind: "agent" },
    ],
    verifier: { kind: "command", commands: [["bun", "run", "check"]] },
    policies: {
      documentationPathOwnership: "docs-prefix-documenter-only",
      docsOnlyImplementSkip: "skip-when-no-non-documentation-paths",
    },
  });
  assert.equal(
    featurePrDefinitionSha256(),
    "d81fd62b250c928c14803bac5769c3794140acdceada395d6897e0bfb0bc4ff3",
  );
  assert.deepEqual(mixed.steps, [
    { id: "implement", actorKind: "agent", status: "pending" },
    { id: "document", actorKind: "agent", status: "pending" },
    {
      id: "verify",
      actorKind: "code",
      status: "pending",
      code: { kind: "command", commands: [["bun", "run", "check"]] },
    },
    { id: "review", actorKind: "agent", status: "pending" },
  ]);
  assert.deepEqual(
    mixed.steps.map((step) => step.id),
    FEATURE_PR_BLOCKS,
  );
  const docsOnly = createFeaturePrManifest({
    plannerRunId: PLANNER_RUN_ID,
    baseSha: BASE_SHA,
    plan: plan(["docs/guide.md"]),
  });
  assert.deepEqual(docsOnly.steps, [
    { id: "implement", actorKind: "agent", status: "skipped", skipReason: "docs-only" },
    { id: "document", actorKind: "agent", status: "pending" },
    {
      id: "verify",
      actorKind: "code",
      status: "pending",
      code: { kind: "command", commands: [["bun", "run", "check"]] },
    },
    { id: "review", actorKind: "agent", status: "pending" },
  ]);
  assert.deepEqual(
    docsOnly.steps.map((step) => step.id),
    FEATURE_PR_BLOCKS,
  );
});

test("manifest rejects tampered, unsupported, and mismatched code definitions", () => {
  const valid = createFeaturePrManifest({
    plannerRunId: PLANNER_RUN_ID,
    baseSha: BASE_SHA,
    plan: plan(["src/x.ts"]),
  });
  assert.throws(
    () => parseWorkflowManifest({ ...valid, extra: true }),
    /invalid workflow manifest/,
  );
  assert.throws(
    () => parseWorkflowManifest({ ...valid, definitionSha256: "0".repeat(64) }),
    /definition hash/,
  );
  assert.throws(
    () => parseWorkflowManifest({ ...valid, workflowId: "other" }),
    /invalid workflow manifest/,
  );
  assert.throws(
    () =>
      parseWorkflowManifest({
        ...valid,
        steps: [valid.steps[3], valid.steps[0], valid.steps[1], valid.steps[2]],
      }),
    /invalid workflow manifest/,
  );
  assert.throws(
    () => parseWorkflowManifest({ ...valid, allowedPaths: ["src/x.ts", "src/x.ts"] }),
    /duplicate paths/,
  );
  const incorrectlySkipped = structuredClone(valid.steps);
  incorrectlySkipped[0] = {
    id: "implement",
    actorKind: "agent",
    status: "skipped",
    skipReason: "docs-only",
  } as never;
  assert.throws(
    () => parseWorkflowManifest({ ...valid, steps: incorrectlySkipped }),
    /steps do not match approved paths/,
  );
  const steps = structuredClone(valid.steps);
  steps[2] = {
    ...steps[2],
    code: { kind: "command", commands: [["node", "-e", "process.exit(0)"]] },
  } as never;
  assert.throws(() => parseWorkflowManifest({ ...valid, steps }), /invalid workflow manifest/);
  const unsupported = structuredClone(valid.steps);
  unsupported[2] = {
    ...unsupported[2],
    code: { kind: "handler", commands: [["bun", "run", "check"]] },
  } as never;
  assert.throws(
    () => parseWorkflowManifest({ ...valid, steps: unsupported }),
    /invalid workflow manifest/,
  );
  const docsOnly = createFeaturePrManifest({
    plannerRunId: PLANNER_RUN_ID,
    baseSha: BASE_SHA,
    plan: plan(["docs/guide.md"]),
  });
  const incorrectlyPending = structuredClone(docsOnly.steps);
  incorrectlyPending[0] = {
    id: "implement",
    actorKind: "agent",
    status: "pending",
  } as never;
  assert.throws(
    () => parseWorkflowManifest({ ...docsOnly, steps: incorrectlyPending }),
    /steps do not match approved paths/,
  );
  assert.throws(
    () =>
      assertFeaturePrManifest(valid, {
        plannerRunId: PLANNER_RUN_ID,
        baseSha: "b".repeat(40),
        plan: plan(["src/x.ts"]),
      }),
    /does not match accepted plan/,
  );
  assert.throws(
    () =>
      assertFeaturePrManifest(valid, {
        plannerRunId: PLANNER_RUN_ID,
        baseSha: BASE_SHA,
        plan: plan(["docs/guide.md"]),
      }),
    /does not match accepted plan/,
  );
  assert.throws(
    () =>
      assertFeaturePrManifest(valid, {
        plannerRunId: "22222222-2222-2222-2222-222222222222",
        baseSha: BASE_SHA,
        plan: plan(["src/x.ts"]),
      }),
    /does not match accepted plan/,
  );
});

test("planner run identity comes from envelope directory or local fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-manifest-"));
  try {
    const runDir = join(root, PLANNER_RUN_ID);
    mkdirSync(runDir);
    const envelope = join(runDir, "envelope.json");
    writeFileSync(envelope, "{}\n");
    assert.equal(plannerRunIdFromEnvelopePath(envelope), PLANNER_RUN_ID);
    assert.equal(plannerRunIdFromEnvelopePath(join(root, "planner.json")), LOCAL_PLANNER_RUN_ID);
    const path = join(root, "workflow-manifest.json");
    writeFileSync(
      path,
      `${JSON.stringify(createFeaturePrManifest({ plannerRunId: LOCAL_PLANNER_RUN_ID, baseSha: BASE_SHA, plan: plan(["src/x.ts"]) }))}\n`,
    );
    assert.equal(readWorkflowManifest(path).plannerRunId, LOCAL_PLANNER_RUN_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
