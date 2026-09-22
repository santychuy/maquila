import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  intakeControllerStatePath,
  readIntakeControllerState,
  writeIntakeControllerState,
  type IntakeControllerState,
} from "../src/intake-controller-state.js";

function state(): IntakeControllerState {
  return {
    version: 1,
    deploymentId: "11111111-1111-4111-8111-111111111111",
    status: "running",
    vmName: "maquila-controller",
    sshDest: "maquila-controller.exe.xyz",
    publicUrl: "https://maquila-controller.exe.xyz",
    port: 8080,
    targetFullName: "santychuycom/santychuy.com",
    targetBaseRef: "main",
    sourceSha: "a".repeat(40),
    sourceDirty: true,
    packageSha256: "b".repeat(64),
    bootPersistent: true,
    controllerPublicKey: `ssh-ed25519 ${"A".repeat(68)} maquila-controller`,
    linearWebhookId: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("intake controller state is strict, atomic, and private", () => {
  const directory = mkdtempSync(join(tmpdir(), "maquila-intake-controller-state-"));
  try {
    const path = intakeControllerStatePath(directory);
    assert.equal(readIntakeControllerState(path), undefined);
    writeIntakeControllerState(path, state());
    assert.deepEqual(readIntakeControllerState(path), state());
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    const malformed = { ...JSON.parse(readFileSync(path, "utf8")), token: "secret" };
    writeFileSync(path, JSON.stringify(malformed));
    assert.throws(() => readIntakeControllerState(path), /malformed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
