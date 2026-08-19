import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { acquireControllerLock } from "../src/controller-lock.js";
import {
  startDetachedRun,
  terminationUnconfirmedPath,
  writeLaunchHandshake,
} from "../src/run-launcher.js";
import { telemetryPath } from "../src/telemetry.js";

const runId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";
const target = {
  path: "/tmp/target-repository",
  owner: "acme",
  repo: "widget",
  baseRef: "main",
  tag: "acme-widget",
};

function root(): string {
  return mkdtempSync(resolve(tmpdir(), "factory-launch-"));
}

function environment(): NodeJS.ProcessEnv {
  return {
    LINEAR_API_TOKEN: "linear-secret",
    GITHUB_TOKEN: "github-secret",
    FACTORY_EXE_IDENTITY: "/tmp/private-identity",
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/home",
    UNRELATED_SECRET: "must-not-cross",
  };
}

test("detached launch returns only after matching accepted handshake", async () => {
  const factoryRoot = root();
  let capturedArgs: string[] = [];
  let capturedEnv: NodeJS.ProcessEnv = {};
  let unref = false;
  try {
    const result = await startDetachedRun({
      factoryRoot,
      target: target.path,
      issue: "RIFF-52",
      timeoutSeconds: 60,
      env: environment(),
      cliPath: "/factory/dist/src/cli.js",
      runId,
      instanceId,
      resolveTarget: () => target,
      spawnChild: (_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        capturedArgs = args;
        capturedEnv = options.env ?? {};
        writeLaunchHandshake(
          factoryRoot,
          runId,
          options.env?.FACTORY_LAUNCH_INSTANCE_ID ?? "",
          4321,
        );
        return {
          pid: 4321,
          exitCode: null,
          signalCode: null,
          kill: () => true,
          unref: () => {
            unref = true;
          },
          once: () => undefined,
        };
      },
      sleep: async () => {},
    });
    assert.deepEqual(result, {
      version: 1,
      accepted: true,
      runId,
      status: "running",
    });
    assert.equal(unref, true);
    assert.equal(capturedArgs.includes(target.path), false);
    assert.doesNotMatch(capturedArgs.join(" "), /linear-secret|github-secret|private-identity/);
    assert.equal(capturedEnv.UNRELATED_SECRET, undefined);
    assert.equal(capturedEnv.LINEAR_API_TOKEN, "linear-secret");
    assert.equal(capturedEnv.FACTORY_EXE_IDENTITY, "/tmp/private-identity");
    assert.equal(capturedEnv.FACTORY_LAUNCH_INSTANCE_ID, instanceId);
    assert.equal(statSync(telemetryPath(factoryRoot, runId)).mode & 0o777, 0o600);
    const launches = resolve(factoryRoot, ".factory", "launches", runId);
    assert.equal(statSync(resolve(launches, "controller.stdout.log")).mode & 0o777, 0o600);
    assert.equal(statSync(resolve(launches, "controller.stderr.log")).mode & 0o777, 0o600);
    const persisted = [
      readFileSync(resolve(launches, "accepted.json"), "utf8"),
      readFileSync(resolve(launches, "controller.stdout.log"), "utf8"),
      readFileSync(resolve(launches, "controller.stderr.log"), "utf8"),
      readFileSync(telemetryPath(factoryRoot, runId), "utf8"),
    ].join("\n");
    assert.doesNotMatch(persisted, /linear-secret|github-secret|private-identity/);
  } finally {
    rmSync(factoryRoot, { recursive: true, force: true });
  }
});

test("child rejection or death before handshake never returns a fake run", async () => {
  for (const exitCode of [1, 127]) {
    const factoryRoot = root();
    try {
      await assert.rejects(
        startDetachedRun({
          factoryRoot,
          target: target.path,
          issue: "RIFF-52",
          timeoutSeconds: 60,
          env: environment(),
          cliPath: "/factory/dist/src/cli.js",
          runId,
          instanceId,
          resolveTarget: () => target,
          spawnChild: () => ({
            pid: 4321,
            exitCode,
            signalCode: null,
            kill: () => true,
            unref: () => {},
            once: () => undefined,
          }),
          sleep: async () => {},
        }),
        /rejected startup/,
      );
      assert.equal(
        statSync(resolve(factoryRoot, ".factory", "launches", runId)).mode & 0o777,
        0o700,
      );
      assert.throws(() => statSync(telemetryPath(factoryRoot, runId)));
    } finally {
      rmSync(factoryRoot, { recursive: true, force: true });
    }
  }
});

test("child death after accepted handshake remains an accepted recoverable run", async () => {
  const factoryRoot = root();
  try {
    const result = await startDetachedRun({
      factoryRoot,
      target: target.path,
      issue: "RIFF-52",
      timeoutSeconds: 60,
      env: environment(),
      cliPath: "/factory/dist/src/cli.js",
      runId,
      instanceId,
      resolveTarget: () => target,
      spawnChild: (_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        writeLaunchHandshake(
          factoryRoot,
          runId,
          options.env?.FACTORY_LAUNCH_INSTANCE_ID ?? "",
          4321,
        );
        return {
          pid: 4321,
          exitCode: 1,
          signalCode: null,
          kill: () => true,
          unref: () => {},
          once: () => undefined,
        };
      },
      sleep: async () => {},
    });
    assert.equal(result.accepted, true);
    assert.equal(result.runId, runId);
  } finally {
    rmSync(factoryRoot, { recursive: true, force: true });
  }
});

test("factory evidence root never resolves into target repository", async () => {
  const factoryRoot = root();
  const targetRoot = root();
  try {
    await startDetachedRun({
      factoryRoot,
      target: targetRoot,
      issue: "RIFF-52",
      timeoutSeconds: 60,
      env: environment(),
      cliPath: "/factory/dist/src/cli.js",
      runId,
      instanceId,
      resolveTarget: () => ({ ...target, path: targetRoot }),
      spawnChild: (_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        writeLaunchHandshake(
          factoryRoot,
          runId,
          options.env?.FACTORY_LAUNCH_INSTANCE_ID ?? "",
          4321,
        );
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
    assert.equal(statSync(telemetryPath(factoryRoot, runId)).isFile(), true);
    assert.throws(() => statSync(telemetryPath(targetRoot, runId)));
  } finally {
    rmSync(factoryRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test("termination race never accepts a handshake created by kill", async () => {
  const factoryRoot = root();
  let unref = false;
  try {
    await assert.rejects(
      startDetachedRun({
        factoryRoot,
        target: target.path,
        issue: "RIFF-52",
        timeoutSeconds: 60,
        startupTimeoutMs: 0,
        terminationTimeoutMs: 1,
        env: environment(),
        cliPath: "/factory/dist/src/cli.js",
        runId,
        instanceId,
        resolveTarget: () => target,
        spawnChild: () => ({
          pid: 4321,
          exitCode: null,
          signalCode: null,
          kill: () => {
            writeLaunchHandshake(factoryRoot, runId, instanceId, 4321);
            return true;
          },
          unref: () => {
            unref = true;
          },
          once: () => undefined,
        }),
        sleep: async () => {},
      }),
      /termination unconfirmed/,
    );
    assert.equal(unref, true);
    assert.equal(statSync(telemetryPath(factoryRoot, runId)).isFile(), true);
    assert.equal(statSync(terminationUnconfirmedPath(factoryRoot, runId)).isFile(), true);
  } finally {
    rmSync(factoryRoot, { recursive: true, force: true });
  }
});

test("signal-exited child rejects, cleans reservation, and releases ownership", async () => {
  const factoryRoot = root();
  let unref = false;
  try {
    await assert.rejects(
      startDetachedRun({
        factoryRoot,
        target: target.path,
        issue: "RIFF-52",
        timeoutSeconds: 60,
        startupTimeoutMs: 0,
        terminationTimeoutMs: 1,
        env: environment(),
        cliPath: "/factory/dist/src/cli.js",
        runId,
        instanceId,
        resolveTarget: () => target,
        spawnChild: () => ({
          pid: 4321,
          exitCode: null,
          signalCode: "SIGTERM",
          kill: () => false,
          unref: () => {
            unref = true;
          },
          once: () => undefined,
        }),
        sleep: async () => {},
      }),
      /rejected startup/,
    );
    assert.equal(unref, true);
    assert.throws(() => statSync(telemetryPath(factoryRoot, runId)));
  } finally {
    rmSync(factoryRoot, { recursive: true, force: true });
  }
});

test("unkillable child preserves ownership and reports termination unconfirmed", async () => {
  const factoryRoot = root();
  let unref = false;
  try {
    await assert.rejects(
      startDetachedRun({
        factoryRoot,
        target: target.path,
        issue: "RIFF-52",
        timeoutSeconds: 60,
        startupTimeoutMs: 0,
        terminationTimeoutMs: 1,
        env: environment(),
        cliPath: "/factory/dist/src/cli.js",
        runId,
        instanceId,
        resolveTarget: () => target,
        spawnChild: () => ({
          pid: 4321,
          exitCode: null,
          signalCode: null,
          kill: () => false,
          unref: () => {
            unref = true;
          },
          once: () => undefined,
        }),
        sleep: async () => {},
      }),
      new RegExp(`termination unconfirmed for run ${runId}`),
    );
    assert.equal(unref, true);
    assert.equal(statSync(telemetryPath(factoryRoot, runId)).isFile(), true);
    const record = JSON.parse(readFileSync(terminationUnconfirmedPath(factoryRoot, runId), "utf8"));
    assert.deepEqual(record, {
      version: 1,
      runId,
      instanceId,
      pid: 4321,
      status: "termination_unconfirmed",
      recordedAt: record.recordedAt,
    });
    assert.equal(statSync(terminationUnconfirmedPath(factoryRoot, runId)).mode & 0o777, 0o600);
  } finally {
    rmSync(factoryRoot, { recursive: true, force: true });
  }
});

test("optional identity omits key path and copies host agent socket", async () => {
  const factoryRoot = root();
  let capturedEnv: NodeJS.ProcessEnv = {};
  try {
    await startDetachedRun({
      factoryRoot,
      target: target.path,
      issue: "RIFF-52",
      timeoutSeconds: 60,
      env: {
        LINEAR_API_TOKEN: "linear-secret",
        GITHUB_TOKEN: "github-secret",
        PATH: "/usr/bin:/bin",
        HOME: "/tmp/home",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        GH_TOKEN: "should-not-copy",
        UNRELATED_SECRET: "must-not-cross",
      },
      cliPath: "/factory/dist/src/cli.js",
      runId,
      instanceId,
      resolveTarget: () => target,
      spawnChild: (_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = options.env ?? {};
        assert.equal(args.includes(target.path), false);
        writeLaunchHandshake(
          factoryRoot,
          runId,
          options.env?.FACTORY_LAUNCH_INSTANCE_ID ?? "",
          4321,
        );
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
    assert.equal(capturedEnv.FACTORY_EXE_IDENTITY, undefined);
    assert.equal(capturedEnv.SSH_AUTH_SOCK, "/tmp/agent.sock");
    assert.equal(capturedEnv.GH_TOKEN, undefined);
    assert.equal(capturedEnv.UNRELATED_SECRET, undefined);
    assert.throws(() => statSync(telemetryPath(target.path, runId)));
  } finally {
    rmSync(factoryRoot, { recursive: true, force: true });
  }
});

test("held controller lock rejects detached launch without fake telemetry", async () => {
  const factoryRoot = root();
  const lock = acquireControllerLock(factoryRoot);
  try {
    await assert.rejects(
      startDetachedRun({
        factoryRoot,
        target: target.path,
        issue: "RIFF-52",
        timeoutSeconds: 60,
        env: environment(),
        cliPath: "/factory/dist/src/cli.js",
        runId,
        instanceId,
        resolveTarget: () => target,
        spawnChild: () => {
          assert.throws(() => acquireControllerLock(factoryRoot), /lock is held/);
          return {
            pid: 4321,
            exitCode: 1,
            signalCode: null,
            kill: () => true,
            unref: () => {},
            once: () => undefined,
          };
        },
        sleep: async () => {},
      }),
      /rejected startup/,
    );
    assert.throws(() => statSync(telemetryPath(factoryRoot, runId)));
  } finally {
    lock.release();
    rmSync(factoryRoot, { recursive: true, force: true });
  }
});
