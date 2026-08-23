import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { runDoctor } from "../src/doctor.js";
const MODELS = new Set(["google/gemini-3.7-flash", "z-ai/glm-5.3"]);
function options(root: string) {
  return {
    maquilaRoot: root,
    target: root,
    env: {},
    homedir: () => root,
    resolveTarget: () => ({
      path: root,
      owner: "acme",
      repo: "demo",
      baseRef: "main",
      tag: "acme-demo",
    }),
    resolveGithub: async () => "github-secret",
    resolveLinear: async () => "linear-secret",
    resolveOpenRouter: async () => "openrouter-secret",
    resolveModelIds: async () => MODELS,
    write: () => undefined,
  };
}
test("doctor uses target snapshot and exe list-only checks without secrets", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-"));
  try {
    mkdirSync(resolve(root, "dist"));
    writeFileSync(resolve(root, "dist/maquila"), "");
    let list = 0;
    const result = await runDoctor({
      ...options(root),
      fetchGithubSnapshot: async (value) => {
        assert.deepEqual(
          { owner: value.owner, repo: value.repo, baseRef: value.baseRef },
          { owner: "acme", repo: "demo", baseRef: "main" },
        );
      },
      listVms: async () => {
        list++;
        return [];
      },
    });
    assert.equal(list, 1);
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("doctor fails GitHub without target and still resolves credentials after invalid config", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-"));
  try {
    let snapshot = 0,
      linearConfig: unknown;
    const result = await runDoctor({
      ...options(root),
      loadConfig: () => {
        throw new Error("bad");
      },
      resolveTarget: () => {
        throw new Error("bad");
      },
      resolveLinear: async (_env, config) => {
        linearConfig = config;
        return "linear";
      },
      fetchGithubSnapshot: async () => {
        snapshot++;
      },
      listVms: async () => [],
    });
    assert.equal(snapshot, 0);
    assert.equal(linearConfig, undefined);
    assert.equal(result.checks.find((item) => item.id === "github")?.status, "fail");
    assert.equal(result.checks.find((item) => item.id === "linear")?.status, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("doctor identity flag overrides environment identity", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-"));
  try {
    const identities: Array<string | undefined> = [];
    await runDoctor({
      ...options(root),
      env: { MAQUILA_EXE_IDENTITY: "/env/key" },
      identity: "/flag/key",
      fetchGithubSnapshot: async () => ({}),
      listVms: async (identity) => {
        identities.push(identity);
        return [];
      },
    });
    await runDoctor({
      ...options(root),
      env: { MAQUILA_EXE_IDENTITY: "/env/key" },
      fetchGithubSnapshot: async () => ({}),
      listVms: async (identity) => {
        identities.push(identity);
        return [];
      },
    });
    assert.deepEqual(identities, ["/flag/key", "/env/key"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor rejects an invalid environment identity before SSH", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-"));
  try {
    let called = false;
    const result = await runDoctor({
      ...options(root),
      env: { MAQUILA_EXE_IDENTITY: "relative-key" },
      fetchGithubSnapshot: async () => ({}),
      listVms: async () => {
        called = true;
        return [];
      },
    });
    assert.equal(called, false);
    assert.equal(result.checks.find((item) => item.id === "ssh")?.status, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
