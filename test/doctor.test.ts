import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { runDoctor } from "../src/doctor.js";

const MODELS = new Set(["google/gemini-3.7-flash", "z-ai/glm-5.3"]);

test("doctor reports redacted readiness checks", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-doctor-"));
  try {
    const result = await runDoctor({
      factoryRoot: root,
      target: root,
      env: { LINEAR_API_TOKEN: "secret-token", GITHUB_TOKEN: "github-secret" },
      homedir: () => root,
      resolveTarget: () => ({
        path: root,
        owner: "acme",
        repo: "demo",
        baseRef: "main",
        tag: "acme-demo",
      }),
      resolveGithub: async () => "github-secret",
      resolveLinear: async () => "secret-token",
      resolveOpenRouter: async () => "openrouter-secret",
      resolveModelIds: async () => MODELS,
      write: () => undefined,
    });
    assert.equal(result.checks.find((item) => item.id === "openrouter")?.status, "pass");
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
    assert.equal(JSON.stringify(result).includes("github-secret"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor fails when a pinned OpenRouter model is unavailable", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-doctor-models-"));
  try {
    const result = await runDoctor({
      factoryRoot: root,
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
      resolveGithub: async () => "github",
      resolveLinear: async () => "linear",
      resolveOpenRouter: async () => "openrouter",
      resolveModelIds: async () => new Set(),
      write: () => undefined,
    });
    const models = result.checks.find((item) => item.id === "models");
    assert.equal(models?.status, "fail");
    assert.match(models?.message ?? "", /google\/gemini-3\.7-flash/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor checks credentials independently and recognizes OpenSSH config", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-doctor-independent-"));
  try {
    mkdirSync(resolve(root, ".ssh"), { recursive: true });
    writeFileSync(resolve(root, ".ssh", "config"), "Host exe.dev\n");
    mkdirSync(resolve(root, "dist"), { recursive: true });
    writeFileSync(resolve(root, "dist/factory"), "");
    const result = await runDoctor({
      factoryRoot: root,
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
      resolveGithub: async () => {
        throw new Error("secret GitHub failure");
      },
      resolveLinear: async () => "linear-secret",
      resolveOpenRouter: async () => "openrouter-secret",
      resolveModelIds: async () => MODELS,
      write: () => undefined,
    });
    assert.equal(result.checks.find((item) => item.id === "github")?.status, "fail");
    assert.equal(result.checks.find((item) => item.id === "linear")?.status, "pass");
    assert.equal(result.checks.find((item) => item.id === "openrouter")?.status, "pass");
    assert.equal(result.checks.find((item) => item.id === "models")?.status, "pass");
    assert.equal(result.checks.find((item) => item.id === "ssh")?.status, "pass");
    assert.equal(JSON.stringify(result).includes("secret"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
