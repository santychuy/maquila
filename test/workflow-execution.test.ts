import assert from "node:assert/strict";
import { test } from "node:test";
import { FEATURE_PR_BLOCKS } from "../src/workflows/feature-pr.js";
import {
  assertFeaturePrExecution,
  completedExecutionRunIds,
  completedStepRunId,
  createFeaturePrExecution,
  implementRunId,
  parseWorkflowExecution,
  primaryRunId,
} from "../src/workflows/execution.js";
import { createFeaturePrManifest } from "../src/workflows/manifest.js";

const PLANNER_RUN_ID = "11111111-1111-1111-1111-111111111111";
const BASE_SHA = "a".repeat(40);
const PATCH = "b".repeat(64);
const RUNS = {
  implementRunId: "22222222-2222-2222-2222-222222222222",
  documenterRunId: "33333333-3333-3333-3333-333333333333",
  reviewerRunId: "44444444-4444-4444-4444-444444444444",
};

function mixedManifest() {
  return createFeaturePrManifest({
    plannerRunId: PLANNER_RUN_ID,
    baseSha: BASE_SHA,
    plan: {
      summary: "Plan",
      evidence: ["Issue"],
      changes: [
        { path: "src/a.ts", action: "modify", rationale: "Code" },
        { path: "docs/a.md", action: "modify", rationale: "Docs" },
      ],
      verification: ["check"],
      risks: [],
      decisionsNeeded: [],
    },
  });
}

test("execution binds completed runs to mixed and docs-only manifests", () => {
  const mixed = createFeaturePrExecution({
    manifest: mixedManifest(),
    ...RUNS,
    reviewedPatchSha256: PATCH,
  });
  assert.equal(mixed.status, "completed");
  assert.deepEqual(
    mixed.steps.map((step) => step.id),
    FEATURE_PR_BLOCKS,
  );
  assert.equal(mixed.steps[2]?.status === "completed" && mixed.steps[2].runId, RUNS.implementRunId);
  const docs = createFeaturePrExecution({
    manifest: createFeaturePrManifest({
      plannerRunId: PLANNER_RUN_ID,
      baseSha: BASE_SHA,
      plan: {
        summary: "Docs",
        evidence: ["Issue"],
        changes: [{ path: "docs/a.md", action: "modify", rationale: "Docs" }],
        verification: ["check"],
        risks: [],
        decisionsNeeded: [],
      },
    }),
    documenterRunId: RUNS.documenterRunId,
    reviewerRunId: RUNS.reviewerRunId,
    reviewedPatchSha256: PATCH,
  });
  assert.deepEqual(
    docs.steps.map((step) => step.id),
    FEATURE_PR_BLOCKS,
  );
  assert.equal(docs.steps[0]?.status, "skipped");
  assert.equal(docs.steps[2]?.status === "completed" && docs.steps[2].runId, RUNS.documenterRunId);
  assert.equal(implementRunId(mixed), RUNS.implementRunId);
  assert.equal(completedStepRunId(mixed, "document"), RUNS.documenterRunId);
  assert.equal(completedStepRunId(mixed, "review"), RUNS.reviewerRunId);
  assert.equal(primaryRunId(mixed), RUNS.implementRunId);
  assert.equal(implementRunId(docs), undefined);
  assert.equal(primaryRunId(docs), RUNS.documenterRunId);
  assert.throws(() => completedStepRunId(docs, "implement"), /not completed/);
});

test("execution rejects skip or run substitutions", () => {
  const valid = createFeaturePrExecution({
    manifest: mixedManifest(),
    ...RUNS,
    reviewedPatchSha256: PATCH,
  });
  assert.throws(
    () => parseWorkflowExecution({ ...valid, extra: true }),
    /invalid workflow execution/,
  );
  assert.throws(
    () =>
      createFeaturePrExecution({
        manifest: mixedManifest(),
        documenterRunId: RUNS.documenterRunId,
        reviewerRunId: RUNS.reviewerRunId,
        reviewedPatchSha256: PATCH,
      }),
    /implement run does not match manifest/,
  );
});

test("assertFeaturePrExecution rejects patch hash mismatch", () => {
  const mixed = createFeaturePrExecution({
    manifest: mixedManifest(),
    ...RUNS,
    reviewedPatchSha256: PATCH,
  });
  assert.throws(
    () => assertFeaturePrExecution(mixed, mixedManifest(), "c".repeat(64)),
    /patch hash mismatch/,
  );
});

test("completedExecutionRunIds stays unique when verify aliases primary", () => {
  const mixed = createFeaturePrExecution({
    manifest: mixedManifest(),
    ...RUNS,
    reviewedPatchSha256: PATCH,
  });
  assert.deepEqual(completedExecutionRunIds(mixed), [
    RUNS.implementRunId,
    RUNS.documenterRunId,
    RUNS.reviewerRunId,
  ]);
  const docs = createFeaturePrExecution({
    manifest: createFeaturePrManifest({
      plannerRunId: PLANNER_RUN_ID,
      baseSha: BASE_SHA,
      plan: {
        summary: "Docs",
        evidence: ["Issue"],
        changes: [{ path: "docs/a.md", action: "modify", rationale: "Docs" }],
        verification: ["check"],
        risks: [],
        decisionsNeeded: [],
      },
    }),
    documenterRunId: RUNS.documenterRunId,
    reviewerRunId: RUNS.reviewerRunId,
    reviewedPatchSha256: PATCH,
  });
  assert.deepEqual(completedExecutionRunIds(docs), [RUNS.documenterRunId, RUNS.reviewerRunId]);
});
