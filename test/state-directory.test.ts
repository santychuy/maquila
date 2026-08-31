import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  acquireControllerLock,
  acquireControllerLockInStateDirectory,
} from "../src/controller-lock.js";
import {
  observerDescriptorPath,
  observerDescriptorPathInStateDirectory,
} from "../src/observer/process.js";
import { handshakePath, handshakePathInStateDirectory } from "../src/run-launcher.js";
import { foldRunStatus, foldRunStatusInStateDirectory } from "../src/run-status.js";
import { batchDirectory, batchDirectoryInStateDirectory } from "../src/runs/batch-state.js";
import { stateDirectory } from "../src/state-directory.js";
import {
  createTelemetryWriter,
  createTelemetryWriterInStateDirectory,
  readTelemetry,
  telemetryPath,
  telemetryPathInStateDirectory,
} from "../src/telemetry.js";

const runId = "11111111-1111-4111-8111-111111111111";
const batchId = "22222222-2222-4222-8222-222222222222";

test("exact state-directory APIs do not append .maquila and root APIs retain it", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-state-root-"));
  const exact = resolve(root, "host-state");
  try {
    assert.equal(stateDirectory(root), resolve(root, ".maquila"));
    assert.equal(
      telemetryPathInStateDirectory(exact, runId),
      resolve(exact, "telemetry", `${runId}.jsonl`),
    );
    assert.equal(
      telemetryPath(root, runId),
      resolve(root, ".maquila", "telemetry", `${runId}.jsonl`),
    );
    assert.equal(
      handshakePathInStateDirectory(exact, runId),
      resolve(exact, "launches", runId, "accepted.json"),
    );
    assert.equal(
      handshakePath(root, runId),
      resolve(root, ".maquila", "launches", runId, "accepted.json"),
    );
    assert.equal(
      batchDirectoryInStateDirectory(exact, batchId),
      resolve(exact, "batches", batchId),
    );
    assert.equal(batchDirectory(root, batchId), resolve(root, ".maquila", "batches", batchId));
    assert.equal(observerDescriptorPathInStateDirectory(exact), resolve(exact, "observer.json"));
    assert.equal(observerDescriptorPath(root), resolve(root, ".maquila", "observer.json"));
    acquireControllerLockInStateDirectory(exact).release();
    assert.equal(resolve(exact, "controller.lock").includes(".maquila"), false);
    acquireControllerLock(root).release();
    assert.equal(
      resolve(root, ".maquila", "controller.lock"),
      stateDirectory(root) + "/controller.lock",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("telemetry append returns the exact sanitized durable record and status accepts exact state", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-state-record-"));
  const exact = resolve(root, "state");
  try {
    const stored = createTelemetryWriterInStateDirectory(exact, runId).append({
      type: "failure",
      actor: "controller",
      payload: { stage: "test", message: "failure" },
    });
    assert.deepEqual(readTelemetry(telemetryPathInStateDirectory(exact, runId)), [stored]);
    assert.equal(
      foldRunStatusInStateDirectory({ stateDirectory: exact, runId }).failure?.message,
      "failure",
    );
    const legacy = createTelemetryWriter(root, runId);
    legacy.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    assert.equal(foldRunStatus({ root, runId }).status, "running");
    assert.match(readFileSync(telemetryPath(root, runId), "utf8"), /run_created/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
