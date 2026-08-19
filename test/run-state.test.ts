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
import {
  createControllerState,
  findOrphanVms,
  readControllerState,
  recordControllerCleanup,
  recoverStaleControllerClaims,
  recordControllerVm,
  scanRecoverableControllerStates,
  transitionControllerState,
  type ControllerStateInput,
} from "../src/run-state.js";

function input(runId: string, idempotencyKey = "a".repeat(64)): ControllerStateInput {
  return {
    runId,
    idempotencyKey,
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
  return join(root, ".factory", "runs", runId);
}

test("controller state writes atomically with strict schema", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-state-"));
  const dir = runDir(root, "run-1");
  try {
    const created = createControllerState(dir, input("run-1"));
    assert.equal(readControllerState(dir).state, "intake");
    assert.equal(created.repositoryId, 123);
    assert.equal(statSync(join(dir, "controller-state.json")).mode & 0o777, 0o600);
    assert.ok(
      statSync(
        join(root, ".factory", "runs", ".idempotency", created.idempotencyKey, "run-id"),
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
  const root = mkdtempSync(join(tmpdir(), "factory-state-"));
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
  const root = mkdtempSync(join(tmpdir(), "factory-state-"));
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
    assert.deepEqual(findOrphanVms(join(root, ".factory", "runs")), [
      {
        runId: "run-1",
        vm: { name: "vm-1", sshDest: "vm.exe.xyz", status: "running" },
        cleanup: "pending",
      },
    ]);
    recordControllerCleanup(dir, "complete");
    assert.deepEqual(findOrphanVms(join(root, ".factory", "runs")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate active and completed inputs are rejected; failed input may retry", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-state-"));
  try {
    const first = runDir(root, "run-1");
    createControllerState(first, input("run-1"));
    assert.throws(
      () => createControllerState(runDir(root, "run-2"), input("run-2")),
      /duplicate active or completed/,
    );
    transitionControllerState(first, "failed");
    createControllerState(runDir(root, "run-2"), input("run-2"));

    const completeRoot = mkdtempSync(join(tmpdir(), "factory-state-complete-"));
    try {
      const completeDir = runDir(completeRoot, "run-1");
      createControllerState(completeDir, input("run-1"));
      for (const next of [
        "creating_vm",
        "bootstrapping",
        "planning",
        "implementing",
        "verifying",
        "reviewing",
        "ready_for_publication",
        "publishing",
        "completed",
      ] as const) {
        transitionControllerState(completeDir, next);
      }
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

test("controller recovery removes claims left before state creation", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-state-"));
  const runs = join(root, ".factory", "controllers");
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
  const root = mkdtempSync(join(tmpdir(), "factory-state-"));
  const dir = runDir(root, "run-1");
  try {
    createControllerState(dir, input("run-1"));
    for (const next of [
      "creating_vm",
      "bootstrapping",
      "planning",
      "implementing",
      "verifying",
      "reviewing",
      "ready_for_publication",
    ] as const)
      transitionControllerState(dir, next);
    assert.deepEqual(scanRecoverableControllerStates(join(root, ".factory", "runs")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphan scan fails closed on malformed state", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-state-"));
  try {
    createControllerState(runDir(root, "run-1"), input("run-1"));
    writeFileSync(join(runDir(root, "run-1"), "controller-state.json"), "{}\n");
    assert.throws(() => findOrphanVms(join(root, ".factory", "runs")), /invalid controller state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
