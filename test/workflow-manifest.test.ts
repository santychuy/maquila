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
    verification: ["factory.verify.json"],
    risks: [],
    decisionsNeeded: [],
  };
}

test("mixed and docs-only manifests are strict and hashed", () => {
  const mixed = createFeaturePrManifest({
    plannerRunId: PLANNER_RUN_ID,
    baseSha: BASE_SHA,
    plan: plan(["src/x.ts", "docs/guide.md"]),
  });
  assert.equal(mixed.workflowId, "feature-pr");
  assert.equal(mixed.definitionSha256, featurePrDefinitionSha256());
  assert.deepEqual(featurePrDefinition(), {
    id: "feature-pr",
    version: 1,
    postPlanSteps: [
      { id: "implement", phase: "implementing", actor: "worker" },
      { id: "document", phase: "documenting", actor: "documenter" },
      { id: "verify", phase: "verifying", actor: "verifier" },
      { id: "review", phase: "reviewing", actor: "reviewer" },
    ],
    policies: {
      documentationPathOwnership: "docs-prefix-documenter-only",
      docsOnlyImplementSkip: "skip-when-no-non-documentation-paths",
    },
  });
  assert.equal(
    featurePrDefinitionSha256(),
    "30cb47c2408814282363592f044a67364c802fe7aa69cddbac991096626ed2e3",
  );
  assert.deepEqual(mixed.steps, [
    { id: "implement", status: "pending" },
    { id: "document", status: "pending" },
    { id: "verify", status: "pending" },
    { id: "review", status: "pending" },
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
    { id: "implement", status: "skipped", skipReason: "docs-only" },
    { id: "document", status: "pending" },
    { id: "verify", status: "pending" },
    { id: "review", status: "pending" },
  ]);
  assert.deepEqual(
    docsOnly.steps.map((step) => step.id),
    FEATURE_PR_BLOCKS,
  );
  assert.equal(docsOnly.steps[0] && "skipReason" in docsOnly.steps[0], true);
});

test("manifest rejects unknown, tampered, and mismatched data", () => {
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
        steps: [
          { id: "review", status: "pending" },
          { id: "implement", status: "pending" },
          { id: "document", status: "pending" },
          { id: "verify", status: "pending" },
        ],
      }),
    /invalid workflow manifest/,
  );
  assert.throws(
    () => parseWorkflowManifest({ ...valid, allowedPaths: ["src/x.ts", "src/x.ts"] }),
    /duplicate paths/,
  );
  assert.throws(
    () => parseWorkflowManifest({ ...valid, allowedPaths: ["factory.verify.json"] }),
    /factory.verify.json/,
  );
  assert.throws(
    () =>
      parseWorkflowManifest({
        ...valid,
        steps: [
          { id: "implement", status: "skipped", skipReason: "docs-only" },
          { id: "document", status: "pending" },
          { id: "verify", status: "pending" },
          { id: "review", status: "pending" },
        ],
      }),
    /steps do not match approved paths/,
  );
  const docsOnly = createFeaturePrManifest({
    plannerRunId: PLANNER_RUN_ID,
    baseSha: BASE_SHA,
    plan: plan(["docs/guide.md"]),
  });
  assert.throws(
    () =>
      parseWorkflowManifest({
        ...docsOnly,
        steps: [
          { id: "implement", status: "pending" },
          { id: "document", status: "pending" },
          { id: "verify", status: "pending" },
          { id: "review", status: "pending" },
        ],
      }),
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
  const root = mkdtempSync(join(tmpdir(), "factory-manifest-"));
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
      `${JSON.stringify(
        createFeaturePrManifest({
          plannerRunId: LOCAL_PLANNER_RUN_ID,
          baseSha: BASE_SHA,
          plan: plan(["src/x.ts"]),
        }),
      )}\n`,
    );
    assert.equal(readWorkflowManifest(path).plannerRunId, LOCAL_PLANNER_RUN_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
