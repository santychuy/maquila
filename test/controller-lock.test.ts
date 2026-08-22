import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireControllerLock, type ControllerLockRuntime } from "../src/controller-lock.js";

test("controller lock blocks live owner and replaces dead owner", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-lock-"));
  try {
    const lock = acquireControllerLock(root);
    assert.throws(() => acquireControllerLock(root), /lock is held/);
    lock.release();
    const path = join(root, ".maquila", "controller.lock");
    writeFileSync(
      path,
      JSON.stringify({ token: "old", pid: 999_999, startedAt: new Date().toISOString() }),
    );
    acquireControllerLock(root).release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale reclamation guard prevents a contender deleting the replacement owner", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-lock-"));
  const path = join(root, ".maquila", "controller.lock");
  mkdirSync(join(root, ".maquila"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ token: "stale", pid: 99, startedAt: new Date().toISOString() }),
  );
  let contenderBlocked = false;
  const runtime: ControllerLockRuntime = {
    pid: 42,
    live: () => false,
    identity: (pid) => `process:${pid}`,
    onOwnerWritten: () => {
      contenderBlocked = true;
      assert.throws(
        () =>
          acquireControllerLock(root, {
            pid: 43,
            live: () => true,
            identity: (pid) => `process:${pid}`,
          }),
        /lock is held/,
      );
      assert.notEqual(JSON.parse(readFileSync(path, "utf8")).token, "stale");
    },
  };
  try {
    const lock = acquireControllerLock(root, runtime);
    assert.equal(contenderBlocked, true);
    lock.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller lock reclaims dead acquisition guard but rejects live guard", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-lock-"));
  const guard = join(root, ".maquila", "controller.lock.acquire");
  try {
    mkdirSync(guard, { recursive: true });
    writeFileSync(
      join(guard, "owner.json"),
      JSON.stringify({
        token: "dead",
        pid: 99,
        startedAt: new Date().toISOString(),
        processIdentity: "dead:1",
      }),
    );
    acquireControllerLock(root, {
      pid: 42,
      live: (pid) => pid === 42,
      identity: (pid) => `live:${pid}`,
    }).release();

    mkdirSync(guard, { recursive: true });
    writeFileSync(
      join(guard, "owner.json"),
      JSON.stringify({
        token: "live",
        pid: 99,
        startedAt: new Date().toISOString(),
        processIdentity: "live:99",
      }),
    );
    assert.throws(
      () =>
        acquireControllerLock(root, {
          pid: 42,
          live: () => true,
          identity: (pid) => `live:${pid}`,
        }),
      /lock is held/,
    );
    assert.throws(
      () => acquireControllerLock(root, { pid: 42, live: () => true, identity: () => undefined }),
      /lock is held/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller lock reclaims an old ownerless acquisition guard", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-lock-"));
  const guard = join(root, ".maquila", "controller.lock.acquire");
  try {
    mkdirSync(guard, { recursive: true });
    const lock = acquireControllerLock(root, {
      pid: 42,
      live: (pid) => pid === 42,
      identity: (pid) => `live:${pid}`,
      now: () => Date.now() + 31_000,
    });
    lock.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reclaimed ownerless guard cannot resume into the critical section", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-lock-"));
  let contender: { release(): void } | undefined;
  try {
    assert.throws(
      () =>
        acquireControllerLock(root, {
          pid: 42,
          live: (pid) => pid === 42,
          identity: (pid) => `live:${pid}`,
          onGuardOwnerOpened: () => {
            contender = acquireControllerLock(root, {
              pid: 43,
              live: (pid) => pid === 43,
              identity: (pid) => `live:${pid}`,
              now: () => Date.now() + 31_000,
            });
          },
        }),
      /guard ownership lost/,
    );
    assert.ok(contender);
    assert.throws(
      () =>
        acquireControllerLock(root, {
          pid: 44,
          live: (pid) => pid === 43 || pid === 44,
          identity: (pid) => `live:${pid}`,
        }),
      /lock is held/,
    );
    contender.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller lock rejects invalid owners and replaces a reused PID", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-lock-"));
  const path = join(root, ".maquila", "controller.lock");
  mkdirSync(join(root, ".maquila"), { recursive: true });
  const runtime: ControllerLockRuntime = {
    pid: 42,
    live: () => true,
    identity: () => "boot:new-start",
  };
  try {
    writeFileSync(
      path,
      JSON.stringify({
        token: "old",
        pid: 42,
        startedAt: new Date().toISOString(),
        processIdentity: "boot:old-start",
      }),
      { flag: "wx" },
    );
    acquireControllerLock(root, runtime).release();

    for (const pid of [0, -1]) {
      writeFileSync(
        path,
        JSON.stringify({ token: "bad", pid, startedAt: new Date().toISOString() }),
      );
      assert.throws(() => acquireControllerLock(root, runtime), /lock is held/);
      rmSync(path);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
