import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { ControllerOptions, ControllerResult } from "../src/controller.js";
import { writeLaunchHandshake } from "../src/run-launcher.js";
import {
  batchStatePath,
  batchTerminationUnconfirmedPath,
  createBatch,
  readBatchState,
  runBatch,
  startDetachedBatch,
} from "../src/run-batch.js";

const batchId = "11111111-1111-4111-8111-111111111111";
const runIds = [
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];

function root(): string {
  return mkdtempSync(resolve(tmpdir(), "maquila-batch-"));
}

test("batch runs issues serially and continues after an independent failure", async () => {
  const directory = root();
  const order: string[] = [];
  let active = 0;
  let maximumActive = 0;
  try {
    createBatch({
      root: directory,
      batchId,
      runIds,
      issues: ["RIFF-101", "RIFF-102", "RIFF-103", "RIFF-104"],
      target: { owner: "acme", repo: "widget", baseRef: "main", tag: "acme-widget" },
      timeoutSeconds: 60,
    });
    const run = async (options: ControllerOptions): Promise<ControllerResult> => {
      options.onAccepted?.();
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(options.issue);
      await new Promise((done) => setTimeout(done, 5));
      active -= 1;
      if (options.issue === "RIFF-102")
        return { status: "failed", runDir: `/runs/${options.runId}`, error: "worker failed" };
      if (options.issue === "RIFF-103")
        return { status: "cancelled", runDir: `/runs/${options.runId}`, error: "cancelled" };
      return { status: "completed", runDir: `/runs/${options.runId}` };
    };

    const state = await runBatch({
      root: directory,
      maquilaRoot: directory,
      batchId,
      linearToken: "linear-secret",
      githubToken: "github-secret",
      openRouterKey: "openrouter-secret",
      run,
    });

    assert.equal(maximumActive, 1);
    assert.deepEqual(order, ["RIFF-101", "RIFF-102", "RIFF-103", "RIFF-104"]);
    assert.equal(state.status, "completed");
    assert.deepEqual(
      state.items.map(({ issue, runId, status }) => ({ issue, runId, status })),
      [
        { issue: "RIFF-101", runId: runIds[0], status: "completed" },
        { issue: "RIFF-102", runId: runIds[1], status: "failed" },
        { issue: "RIFF-103", runId: runIds[2], status: "cancelled" },
        { issue: "RIFF-104", runId: runIds[3], status: "completed" },
      ],
    );
    assert.equal(statSync(batchStatePath(directory, batchId)).mode & 0o777, 0o600);
    assert.doesNotMatch(
      readFileSync(batchStatePath(directory, batchId), "utf8"),
      /linear-secret|github-secret|openrouter-secret/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("batch stops queued items when a later controller cannot start", async () => {
  const directory = root();
  const calls: string[] = [];
  try {
    createBatch({
      root: directory,
      batchId,
      runIds: runIds.slice(0, 3),
      issues: ["RIFF-101", "RIFF-102", "RIFF-103"],
      target: { owner: "acme", repo: "widget", baseRef: "main", tag: "acme-widget" },
      timeoutSeconds: 60,
    });
    await assert.rejects(
      runBatch({
        root: directory,
        maquilaRoot: directory,
        batchId,
        linearToken: "linear-secret",
        githubToken: "github-secret",
        openRouterKey: "openrouter-secret",
        run: async (options: ControllerOptions): Promise<ControllerResult> => {
          calls.push(options.issue);
          if (options.issue === "RIFF-102") throw new Error("controller lock is held");
          options.onAccepted?.();
          return { status: "completed", runDir: `/runs/${options.runId}` };
        },
      }),
      /lock is held/,
    );

    assert.deepEqual(calls, ["RIFF-101", "RIFF-102"]);
    const state = readBatchState(directory, batchId);
    assert.equal(state.status, "failed");
    assert.deepEqual(
      state.items.map(({ status }) => status),
      ["completed", "failed", "queued"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("batch continues after an accepted controller throws", async () => {
  const directory = root();
  try {
    createBatch({
      root: directory,
      batchId,
      runIds: runIds.slice(0, 2),
      issues: ["RIFF-101", "RIFF-102"],
      target: { owner: "acme", repo: "widget", baseRef: "main", tag: "acme-widget" },
      timeoutSeconds: 60,
    });
    const state = await runBatch({
      root: directory,
      maquilaRoot: directory,
      batchId,
      linearToken: "linear-secret",
      githubToken: "github-secret",
      openRouterKey: "openrouter-secret",
      run: async (options: ControllerOptions): Promise<ControllerResult> => {
        options.onAccepted?.();
        if (options.issue === "RIFF-101") throw new Error("accepted controller failed");
        return { status: "completed", runDir: `/runs/${options.runId}` };
      },
    });

    assert.equal(state.status, "completed");
    assert.deepEqual(
      state.items.map(({ status }) => status),
      ["failed", "completed"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("detached batch returns independent run IDs after coordinator acceptance", async () => {
  const directory = root();
  const instanceId = "55555555-5555-4555-8555-555555555555";
  let capturedArgs: string[] = [];
  let capturedEnv: NodeJS.ProcessEnv = {};
  try {
    createBatch({
      root: directory,
      batchId,
      runIds: runIds.slice(0, 2),
      issues: ["RIFF-101", "RIFF-102"],
      target: { owner: "acme", repo: "widget", baseRef: "main", tag: "acme-widget" },
      timeoutSeconds: 60,
    });
    const result = await startDetachedBatch({
      root: directory,
      batchId,
      instanceId,
      cliPath: "/maquila/dist/src/cli.js",
      env: {
        LINEAR_API_TOKEN: "linear-secret",
        GITHUB_TOKEN: "github-secret",
        OPENROUTER_API_KEY: "openrouter-secret",
        PATH: "/usr/bin:/bin",
        HOME: "/tmp/home",
        UNRELATED_SECRET: "must-not-cross",
      },
      spawnChild: (_command, args, options) => {
        capturedArgs = args;
        capturedEnv = options.env ?? {};
        writeLaunchHandshake(directory, batchId, instanceId, 4321);
        return {
          pid: 4321,
          exitCode: null,
          signalCode: null,
          kill: () => true,
          unref: () => {},
          once: () => undefined,
        };
      },
      sleep: async () => {},
    });

    assert.deepEqual(result.runs, [
      { issue: "RIFF-101", runId: runIds[0] },
      { issue: "RIFF-102", runId: runIds[1] },
    ]);
    assert.deepEqual(capturedArgs.slice(-6), [
      "/maquila/dist/src/cli.js",
      "run",
      "batch",
      "execute",
      "--batch-id",
      batchId,
    ]);
    assert.equal(capturedEnv.UNRELATED_SECRET, undefined);
    assert.equal(capturedEnv.LINEAR_API_TOKEN, "linear-secret");
    assert.doesNotMatch(capturedArgs.join(" "), /linear-secret|github-secret|openrouter-secret/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("detached batch records unconfirmed coordinator termination", async () => {
  const directory = root();
  const instanceId = "66666666-6666-4666-8666-666666666666";
  const signals: Array<NodeJS.Signals | undefined> = [];
  try {
    createBatch({
      root: directory,
      batchId,
      runIds: runIds.slice(0, 2),
      issues: ["RIFF-101", "RIFF-102"],
      target: { owner: "acme", repo: "widget", baseRef: "main", tag: "acme-widget" },
      timeoutSeconds: 60,
    });
    await assert.rejects(
      startDetachedBatch({
        root: directory,
        batchId,
        instanceId,
        cliPath: "/maquila/dist/src/cli.js",
        startupTimeoutMs: 1,
        terminationTimeoutMs: 1,
        env: {
          LINEAR_API_TOKEN: "linear-secret",
          GITHUB_TOKEN: "github-secret",
          OPENROUTER_API_KEY: "openrouter-secret",
          PATH: "/usr/bin:/bin",
          HOME: "/tmp/home",
        },
        spawnChild: () => ({
          pid: 4321,
          exitCode: null,
          signalCode: null,
          kill: (signal) => {
            signals.push(signal);
            return true;
          },
          unref: () => {},
          once: () => undefined,
        }),
        sleep: async () => {},
      }),
      /termination unconfirmed/,
    );

    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    const record = readFileSync(batchTerminationUnconfirmedPath(directory, batchId), "utf8");
    assert.match(record, new RegExp(`"batchId":"${batchId}"`));
    assert.match(record, /"pid":4321/);
    assert.doesNotMatch(record, /linear-secret|github-secret|openrouter-secret/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("batch state rejects duplicate issues and unknown fields", () => {
  const directory = root();
  try {
    assert.throws(
      () =>
        createBatch({
          root: directory,
          issues: ["RIFF-101", "RIFF-101"],
          target: { owner: "acme", repo: "widget", baseRef: "main", tag: "acme-widget" },
          timeoutSeconds: 60,
        }),
      /2 to 10 unique/,
    );
    createBatch({
      root: directory,
      batchId,
      runIds: runIds.slice(0, 2),
      issues: ["RIFF-101", "RIFF-102"],
      target: { owner: "acme", repo: "widget", baseRef: "main", tag: "acme-widget" },
      timeoutSeconds: 60,
    });
    const value = JSON.parse(readFileSync(batchStatePath(directory, batchId), "utf8"));
    value.untrusted = true;
    writeFileSync(batchStatePath(directory, batchId), `${JSON.stringify(value)}\n`, {
      mode: 0o600,
    });
    assert.throws(() => readBatchState(directory, batchId), /invalid batch state/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
