import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlannerEnvelope } from "../src/envelope.js";
import {
  FEATURE_PR_WORKFLOW_ID,
  FEATURE_PR_WORKFLOW_VERSION,
  authorizedFeaturePrPaths,
  featurePrRemoteStepsFromManifest,
  resolveFeaturePr,
} from "../src/workflows/feature-pr.js";
import { createFeaturePrManifest } from "../src/workflows/manifest.js";

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

test("mixed plan keeps implement then document, verify, and review", () => {
  const resolved = resolveFeaturePr(plan(["src/x.ts", "docs/guide.md"]));
  assert.equal(resolved.id, FEATURE_PR_WORKFLOW_ID);
  assert.equal(resolved.version, FEATURE_PR_WORKFLOW_VERSION);
  assert.deepEqual(resolved.allowedPaths, ["src/x.ts", "docs/guide.md"]);
  assert.deepEqual(resolved.implementPaths, ["src/x.ts"]);
  assert.deepEqual(resolved.documentPaths, ["docs/guide.md"]);
  const mixed = createFeaturePrManifest({
    plannerRunId: "local",
    baseSha: "a".repeat(40),
    plan: plan(["src/x.ts", "docs/guide.md"]),
  });
  assert.deepEqual(featurePrRemoteStepsFromManifest(mixed.steps), [
    { id: "implement", phase: "implementing", actor: "worker", actorKind: "agent" },
    { id: "document", phase: "documenting", actor: "documenter", actorKind: "agent" },
    { id: "verify", phase: "verifying", actor: "verifier", actorKind: "code" },
    { id: "review", phase: "reviewing", actor: "reviewer", actorKind: "agent" },
  ]);
});

test("docs-only plan skips implement", () => {
  const resolved = resolveFeaturePr(plan(["docs/guide.md"]));
  assert.deepEqual(resolved.implementPaths, []);
  assert.deepEqual(resolved.documentPaths, ["docs/guide.md"]);
  const docsOnly = createFeaturePrManifest({
    plannerRunId: "local",
    baseSha: "a".repeat(40),
    plan: plan(["docs/guide.md"]),
  });
  assert.deepEqual(featurePrRemoteStepsFromManifest(docsOnly.steps), [
    { id: "document", phase: "documenting", actor: "documenter", actorKind: "agent" },
    { id: "verify", phase: "verifying", actor: "verifier", actorKind: "code" },
    { id: "review", phase: "reviewing", actor: "reviewer", actorKind: "agent" },
  ]);
  assert.equal(docsOnly.steps.find((step) => step.id === "implement")?.status, "skipped");
});

test("authorized paths reject duplicates", () => {
  assert.throws(() => authorizedFeaturePrPaths(plan(["src/a.ts", "src/a.ts"])), /duplicate paths/);
});
