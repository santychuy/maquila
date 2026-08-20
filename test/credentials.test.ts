import assert from "node:assert/strict";
import { test } from "node:test";
import { controllerChildEnvironment, resolveControllerCredentials } from "../src/credentials.js";

test("GITHUB_TOKEN wins over GH_TOKEN and gh", async () => {
  const calls: string[] = [];
  const result = await resolveControllerCredentials({
    env: {
      GITHUB_TOKEN: "github-primary",
      GH_TOKEN: "github-secondary",
      LINEAR_API_TOKEN: "linear-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
      PATH: "/usr/bin",
    },
    runGh: async () => {
      calls.push("gh");
      return "gh-token";
    },
    runOp: async () => {
      calls.push("op");
      return "op-token";
    },
  });
  assert.equal(result.githubToken, "github-primary");
  assert.equal(result.linearToken, "linear-secret");
  assert.equal(result.identity, undefined);
  assert.deepEqual(calls, []);
});

test("GH_TOKEN is used when GITHUB_TOKEN is absent", async () => {
  const result = await resolveControllerCredentials({
    env: {
      GH_TOKEN: "github-secondary",
      LINEAR_API_TOKEN: "linear-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
    },
    runGh: async () => "should-not-run",
    runOp: async () => "should-not-run",
  });
  assert.equal(result.githubToken, "github-secondary");
});

test("gh auth token is used when env tokens are absent", async () => {
  let envSeen: NodeJS.ProcessEnv = {};
  const result = await resolveControllerCredentials({
    env: {
      LINEAR_API_TOKEN: "linear-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
      PATH: "/bin",
      UNRELATED_SECRET: "nope",
    },
    runGh: async (_file, args, env) => {
      envSeen = env;
      assert.deepEqual(args, ["auth", "token"]);
      return "gh-token\n";
    },
    runOp: async () => "nope",
  });
  assert.equal(result.githubToken, "gh-token");
  assert.equal(envSeen.UNRELATED_SECRET, undefined);
  assert.equal(envSeen.LINEAR_API_TOKEN, undefined);
});

test("op reference is used only when Linear env is absent", async () => {
  let opArgs: string[] = [];
  const result = await resolveControllerCredentials({
    env: {
      GITHUB_TOKEN: "github-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
      PATH: "/bin",
      OP_SESSION: "session-secret",
    },
    config: { version: 1, linear: { tokenReference: "op://Vault/Item/field" } },
    runGh: async () => "nope",
    runOp: async (_file, args, env) => {
      opArgs = args;
      assert.equal(env.OP_SESSION, undefined);
      return "linear-from-op";
    },
  });
  assert.equal(result.linearToken, "linear-from-op");
  assert.deepEqual(opArgs, ["read", "--no-newline", "op://Vault/Item/field"]);
});

test("OPENROUTER_API_KEY wins over 1Password reference", async () => {
  const result = await resolveControllerCredentials({
    env: {
      GITHUB_TOKEN: "github-secret",
      LINEAR_API_TOKEN: "linear-secret",
      OPENROUTER_API_KEY: "openrouter-env",
    },
    config: { version: 1, openrouter: { tokenReference: "op://Vault/OpenRouter/token" } },
    runOp: async () => {
      throw new Error("should not run");
    },
  });
  assert.equal(result.openRouterKey, "openrouter-env");
});

test("OpenRouter 1Password reference is used when env is absent", async () => {
  const result = await resolveControllerCredentials({
    env: { GITHUB_TOKEN: "github-secret", LINEAR_API_TOKEN: "linear-secret" },
    config: { version: 1, openrouter: { tokenReference: "op://Vault/OpenRouter/token" } },
    runOp: async (_file, args) => {
      assert.deepEqual(args, ["read", "--no-newline", "op://Vault/OpenRouter/token"]);
      return "openrouter-op";
    },
  });
  assert.equal(result.openRouterKey, "openrouter-op");
});

test("identity is optional and must be absolute when set", async () => {
  const result = await resolveControllerCredentials({
    env: {
      GITHUB_TOKEN: "g",
      LINEAR_API_TOKEN: "l",
      OPENROUTER_API_KEY: "o",
      FACTORY_EXE_IDENTITY: "/tmp/key",
    },
  });
  assert.equal(result.identity, "/tmp/key");
  await assert.rejects(
    () =>
      resolveControllerCredentials({
        env: { GITHUB_TOKEN: "g", LINEAR_API_TOKEN: "l", OPENROUTER_API_KEY: "o" },
        identityFlag: "relative",
      }),
    /absolute path/,
  );
});

test("public errors omit secret material", async () => {
  await assert.rejects(
    () =>
      resolveControllerCredentials({
        env: { LINEAR_API_TOKEN: "linear-secret", OPENROUTER_API_KEY: "openrouter-secret" },
        runGh: async () => {
          throw new Error("token=ghp_secret");
        },
      }),
    (error: Error) =>
      error.message === "GitHub CLI auth is unavailable" && !error.message.includes("ghp_secret"),
  );
  await assert.rejects(
    () =>
      resolveControllerCredentials({
        env: { GITHUB_TOKEN: "github-secret", OPENROUTER_API_KEY: "openrouter-secret" },
        config: { version: 1, linear: { tokenReference: "op://Vault/Item/field" } },
        runOp: async () => {
          throw new Error("op://Vault/Item/field leaked");
        },
      }),
    (error: Error) => error.message === "1Password reference could not be read",
  );
});

test("child environment keeps agent socket and drops unrelated secrets", () => {
  const env = controllerChildEnvironment(
    {
      PATH: "/bin",
      HOME: "/tmp/home",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GH_TOKEN: "should-drop",
      UNRELATED_SECRET: "nope",
    },
    { linearToken: "l", githubToken: "g", openRouterKey: "o" },
  );
  assert.equal(env.SSH_AUTH_SOCK, "/tmp/agent.sock");
  assert.equal(env.LINEAR_API_TOKEN, "l");
  assert.equal(env.GITHUB_TOKEN, "g");
  assert.equal(env.OPENROUTER_API_KEY, "o");
  assert.equal(env.FACTORY_EXE_IDENTITY, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.UNRELATED_SECRET, undefined);
});
