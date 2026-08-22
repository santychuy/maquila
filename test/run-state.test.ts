import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FEATURE_PR_BLOCKS } from "../src/workflows/feature-pr.js";
import { featurePrDefinitionSha256 } from "../src/workflows/manifest.js";
import {
  beginControllerDecisionWait,
  completeControllerWorkflow,
  createControllerState,
  findOrphanVms,
  pinControllerWorkflowManifest,
  readControllerState,
  recordControllerCleanup,
  recoverStaleControllerClaims,
  recordControllerVm,
  recordControllerWorkflowStep,
  scanRecoverableControllerStates,
  transitionControllerState,
  type ControllerStateInput,
} from "../src/run-state.js";

function input(runId: string, idempotencyKey = "a".repeat(64)): ControllerStateInput {
  return {
    runId,
    idempotencyKey,
    workflow: { id: "feature-pr", version: 1, definitionSha256: featurePrDefinitionSha256() },
    issueUuid: "7c3cd7a0-2503-40fe-9f33-56588786452a",
    issueSnapshotSha256: "b".repeat(64),
    repositoryId: 123,
    repositoryFullName: "santychuy/bookbounce",
    repositorySnapshotSha256: "c".repeat(64),
    baseRef: "main",
    baseSha: "d".repeat(40),
  };
}

function runDir(root: string, runId: string): string {
  return join(root, ".maquila", "runs", runId);
}

test("controller state writes atomically with strict schema", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-state-"));
  const dir = runDir(root, "run-1");
  try {
    const created = createControllerState(dir, input("run-1"));
    assert.equal(readControllerState(dir).state, "intake");
    assert.equal(created.repositoryId, 123);
    assert.equal(statSync(join(dir, "controller-state.json")).mode & 0o777, 0o600);
    assert.ok(
      statSync(
        join(root, ".maquila", "runs", ".idempotency", created.idempotencyKey, "run-id"),
      ).isFile(),
    );
    const serialized = readFileSync(join(dir, "controller-state.json"), "utf8");
    assert.ok(!serialized.includes("token"));
    assert.deepEqual(statSync(dir).isDirectory(), true);

    writeFileSync(
      join(dir, "controller-state.json"),
      JSON.stringify({ ...created, cleanup: "pending" }),
    );
    assert.throws(() => readControllerState(dir), /invalid controller state/);
    writeFileSync(
      join(dir, "controller-state.json"),
      JSON.stringify({ ...created, unexpected: true }),
    );
    assert.throws(() => readControllerState(dir), /invalid controller state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derived-name cleanup may complete without recording a VM", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-state-"));
  const dir = runDir(root, "run-1");
  try {
    createControllerState(dir, input("run-1"));
    transitionControllerState(dir, "creating_vm");
    assert.equal(recordControllerCleanup(dir, "complete").cleanup, "complete");
    assert.throws(() => recordControllerCleanup(dir, "pending"), /requires a recorded VM/);
    assert.throws(() => recordControllerCleanup(dir, "failed"), /requires a recorded VM/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller rejects invalid transitions and records VM before bootstrap", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-state-"));
  const dir = runDir(root, "run-1");
  try {
    createControllerState(dir, input("run-1"));
    assert.throws(() => transitionControllerState(dir, "planning"), /invalid transition/);
    assert.throws(
      () => recordControllerVm(dir, { name: "vm-1", sshDest: "vm.exe.xyz", status: "running" }),
      /creating_vm/,
    );
    transitionControllerState(dir, "creating_vm");
    const withVm = recordControllerVm(dir, {
      name: "vm-1",
      sshDest: "vm.exe.xyz",
      status: "running",
    });
    assert.equal(withVm.cleanup, "pending");
    const bootstrapping = transitionControllerState(dir, "bootstrapping");
    assert.equal(bootstrapping.issueSnapshotSha256, input("run-1").issueSnapshotSha256);
    assert.equal(bootstrapping.baseSha, input("run-1").baseSha);
    assert.deepEqual(findOrphanVms(join(root, ".maquila", "runs")), [
      {
        runId: "run-1",
        vm: { name: "vm-1", sshDest: "vm.exe.xyz", status: "running" },
        cleanup: "pending",
      },
    ]);
    recordControllerCleanup(dir, "complete");
    assert.deepEqual(findOrphanVms(join(root, ".maquila", "runs")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate active and completed inputs are rejected; failed and legacy ready inputs may retry", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-state-"));
  try {
    const first = runDir(root, "run-1");
    createControllerState(first, input("run-1"));
    assert.throws(
      () => createControllerState(runDir(root, "run-2"), input("run-2")),
      /duplicate active or completed/,
    );
    transitionControllerState(first, "failed");
    createControllerState(runDir(root, "run-2"), input("run-2"));

    const decisionRoot = mkdtempSync(join(tmpdir(), "maquila-state-decision-"));
    try {
      const decisionDir = runDir(decisionRoot, "run-1");
      const created = createControllerState(decisionDir, input("run-1"));
      const { workflow: _workflow, ...common } = created;
      writeFileSync(
        join(decisionDir, "controller-state.json"),
        `${JSON.stringify({ ...common, version: 1, state: "awaiting_decision" })}\n`,
      );
      createControllerState(runDir(decisionRoot, "run-2"), input("run-2"));
    } finally {
      rmSync(decisionRoot, { recursive: true, force: true });
    }

    const readyRoot = mkdtempSync(join(tmpdir(), "maquila-state-ready-"));
    try {
      const readyDir = runDir(readyRoot, "run-1");
      createControllerState(readyDir, input("run-1"));
      for (const next of ["creating_vm", "bootstrapping", "executing"] as const)
        transitionControllerState(readyDir, next);
      recordControllerWorkflowStep(readyDir, "plan", 1);
      pinControllerWorkflowManifest(readyDir, "f".repeat(64));
      for (const step of ["document", "verify", "review"] as const)
        recordControllerWorkflowStep(readyDir, step, 1);
      completeControllerWorkflow(readyDir, "f".repeat(64));
      createControllerState(runDir(readyRoot, "run-2"), input("run-2"));
    } finally {
      rmSync(readyRoot, { recursive: true, force: true });
    }

    const completeRoot = mkdtempSync(join(tmpdir(), "maquila-state-complete-"));
    try {
      const completeDir = runDir(completeRoot, "run-1");
      createControllerState(completeDir, input("run-1"));
      for (const next of ["creating_vm", "bootstrapping", "executing"] as const)
        transitionControllerState(completeDir, next);
      recordControllerWorkflowStep(completeDir, "plan", 1);
      pinControllerWorkflowManifest(completeDir, "f".repeat(64));
      for (const step of ["implement", "document", "verify", "review"] as const)
        recordControllerWorkflowStep(completeDir, step, 1);
      completeControllerWorkflow(completeDir, "f".repeat(64));
      for (const next of ["publishing", "completed"] as const)
        transitionControllerState(completeDir, next);
      assert.throws(
        () => createControllerState(runDir(completeRoot, "run-2"), input("run-2")),
        /duplicate active or completed/,
      );
    } finally {
      rmSync(completeRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained decision wait keeps claim and can resume planning", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-state-decision-"));
  const dir = runDir(root, "run-1");
  try {
    createControllerState(dir, input("run-1"));
    transitionControllerState(dir, "creating_vm");
    recordControllerVm(dir, { name: "vm-1", sshDest: "vm.exe.xyz", status: "running" });
    for (const next of ["bootstrapping", "executing"] as const)
      transitionControllerState(dir, next);
    recordControllerWorkflowStep(dir, "plan", 1);
    const waiting = beginControllerDecisionWait(dir, {
      generation: 1,
      expiresAt: "2026-01-02T00:00:00.000Z",
      plannerRunId: "planner-run-1",
      plannerSessionId: "session-1",
      plannerSessionSha256: "e".repeat(64),
      checkpointSha256: "f".repeat(64),
    });
    assert.equal(waiting.state, "awaiting_decision");
    assert.equal(waiting.cleanup, "pending");
    assert.equal(scanRecoverableControllerStates(join(root, ".maquila", "runs")).length, 1);
    assert.throws(
      () => createControllerState(runDir(root, "run-2"), input("run-2")),
      /duplicate active or completed/,
    );
    assert.equal(transitionControllerState(dir, "executing").state, "executing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller recovery removes claims left before state creation", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-state-"));
  const runs = join(root, ".maquila", "controllers");
  const claims = join(runs, ".idempotency");
  try {
    const empty = join(claims, "a".repeat(64));
    const owned = join(claims, "b".repeat(64));
    mkdirSync(empty, { recursive: true });
    mkdirSync(owned, { recursive: true });
    writeFileSync(join(owned, "run-id"), "missing-run\n");
    recoverStaleControllerClaims(runs);
    assert.equal(existsSync(empty), false);
    assert.equal(existsSync(owned), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ready state requires cleanup and is excluded from recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-state-"));
  const dir = runDir(root, "run-1");
  try {
    createControllerState(dir, input("run-1"));
    for (const next of ["creating_vm", "bootstrapping", "executing"] as const)
      transitionControllerState(dir, next);
    recordControllerWorkflowStep(dir, "plan", 1);
    pinControllerWorkflowManifest(dir, "f".repeat(64));
    for (const step of ["implement", "document", "verify", "review"] as const)
      recordControllerWorkflowStep(dir, step, 1);
    completeControllerWorkflow(dir, "f".repeat(64));
    assert.deepEqual(scanRecoverableControllerStates(join(root, ".maquila", "runs")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v2 workflow cursor and manifest pinning fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-state-workflow-"));
  const dir = runDir(root, "run-1");
  try {
    const created = createControllerState(dir, input("run-1"));
    assert.equal(created.version, 2);
    assert.deepEqual(created.workflow, input("run-1").workflow);
    assert.throws(() => recordControllerWorkflowStep(dir, "plan", 1), /executing state v2/);
    for (const next of ["creating_vm", "bootstrapping", "executing"] as const)
      transitionControllerState(dir, next);
    assert.throws(() => recordControllerWorkflowStep(dir, "document", 1), /cursor transition/);
    assert.throws(() => recordControllerWorkflowStep(dir, "plan", 0), /invalid workflow cursor/);
    recordControllerWorkflowStep(dir, "plan", 1);
    assert.throws(() => recordControllerWorkflowStep(dir, "plan", 3), /cursor transition/);
    assert.throws(() => pinControllerWorkflowManifest(dir, "bad"), /manifest hash/);
    pinControllerWorkflowManifest(dir, "f".repeat(64));
    assert.throws(
      () => pinControllerWorkflowManifest(dir, "a".repeat(64)),
      /manifest hash changed/,
    );
    assert.throws(
      () => completeControllerWorkflow(dir, "f".repeat(64)),
      /not ready for publication/,
    );
    for (const step of ["document", "verify", "review"] as const)
      recordControllerWorkflowStep(dir, step, 1);
    assert.throws(
      () => completeControllerWorkflow(dir, "a".repeat(64)),
      /not ready for publication/,
    );
    assert.equal(completeControllerWorkflow(dir, "f".repeat(64)).state, "ready_for_publication");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v2 full cursor progression follows code-owned feature-pr blocks", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-state-blocks-"));
  const dir = runDir(root, "run-1");
  try {
    createControllerState(dir, input("run-1"));
    for (const next of ["creating_vm", "bootstrapping", "executing"] as const)
      transitionControllerState(dir, next);
    recordControllerWorkflowStep(dir, "plan", 1);
    pinControllerWorkflowManifest(dir, "f".repeat(64));
    for (const step of FEATURE_PR_BLOCKS)
      assert.equal(recordControllerWorkflowStep(dir, step, 1).workflow.currentStepId, step);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy retained decision wait reads and resumes without version rewrite", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-state-legacy-"));
  const dir = runDir(root, "run-1");
  try {
    const created = createControllerState(dir, input("run-1"));
    const { workflow: _workflow, ...common } = created;
    writeFileSync(
      join(dir, "controller-state.json"),
      `${JSON.stringify({
        ...common,
        version: 1,
        state: "awaiting_decision",
        cleanup: "pending",
        vm: { name: "vm-1", sshDest: "vm.exe.xyz", status: "running" },
        decisionWait: {
          generation: 1,
          expiresAt: "2026-01-02T00:00:00.000Z",
          plannerRunId: "planner-run-1",
          plannerSessionId: "session-1",
          plannerSessionSha256: "e".repeat(64),
          checkpointSha256: "f".repeat(64),
        },
      })}\n`,
    );
    assert.equal(readControllerState(dir).version, 1);
    assert.equal(scanRecoverableControllerStates(join(root, ".maquila", "runs")).length, 1);
    assert.deepEqual(findOrphanVms(join(root, ".maquila", "runs")), [
      {
        runId: "run-1",
        vm: { name: "vm-1", sshDest: "vm.exe.xyz", status: "running" },
        cleanup: "pending",
      },
    ]);
    const resumed = transitionControllerState(dir, "planning");
    assert.equal(resumed.version, 1);
    assert.equal(resumed.state, "planning");
    assert.equal(readControllerState(dir).version, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphan scan fails closed on malformed state", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-state-"));
  try {
    createControllerState(runDir(root, "run-1"), input("run-1"));
    writeFileSync(join(runDir(root, "run-1"), "controller-state.json"), "{}\n");
    assert.throws(() => findOrphanVms(join(root, ".maquila", "runs")), /invalid controller state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
