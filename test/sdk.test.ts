import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createExeExecutionProvider,
  createGitHubSourceControlProvider,
  createLinearWorkItemProvider,
  createMaquila,
} from "../src/index.js";
import type { ExecutionProvider, SourceControlProvider, WorkItemProvider } from "../src/index.js";
import { runMaquila } from "../src/maquila.js";
import { builtInMaquilaInvocation } from "../src/cli/maquila-runtime.js";

const workItems: WorkItemProvider = {
  async fetchWorkItem() {
    throw new Error("controlled intake failure");
  },
  async requestDecision() {
    throw new Error("unreachable");
  },
  async waitForDecision() {
    return undefined;
  },
};
const sourceControl: SourceControlProvider = {
  async fetchSourceControl() {
    throw new Error("unreachable");
  },
  cloneUrl() {
    return "";
  },
  dryRunPublication() {
    throw new Error("unreachable");
  },
  async publishReviewedPatch() {
    throw new Error("unreachable");
  },
};
const execution: ExecutionProvider = {
  async createVm() {
    throw new Error("unreachable");
  },
  async destroyVm() {
    return { destroyed: false, notFound: true };
  },
  async exec() {
    return { stdout: "", stderr: "" };
  },
  async execStream() {
    return { stderr: "" };
  },
  async copyTo() {
    return { stdout: "", stderr: "" };
  },
  async copyFrom() {
    return { stdout: "", stderr: "" };
  },
};
function everyFile(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? everyFile(path) : [path];
  });
}
test("SDK validates its closed public config and request shapes", async () => {
  assert.throws(
    () =>
      createMaquila({
        workItemProvider: workItems,
        sourceControlProvider: sourceControl,
        executionProvider: execution,
        stateDirectory: "/tmp",
        openRouterApiKey: "key",
        extra: true,
      } as never),
    /unknown fields/,
  );
  assert.throws(
    () =>
      createMaquila({
        workItemProvider: workItems,
        sourceControlProvider: sourceControl,
        executionProvider: execution,
        stateDirectory: "relative",
        openRouterApiKey: "key",
      }),
    /absolute/,
  );
  const directory = mkdtempSync(join(tmpdir(), "maquila-sdk-"));
  try {
    const maquila = createMaquila({
      workItemProvider: workItems,
      sourceControlProvider: sourceControl,
      executionProvider: execution,
      stateDirectory: directory,
      openRouterApiKey: "key",
    });
    await assert.rejects(
      maquila.run({
        workItem: { provider: "linear", id: "ENG-1" },
        sourceControl: { provider: "github", repository: "owner/repo/extra", baseRef: "main" },
        execution: { provider: "exe.dev", tag: "tag" },
      }),
      /owner\/repo/,
    );
    await assert.rejects(
      maquila.run({
        workItem: { provider: "linear", id: "ENG-1", token: "secret" } as never,
        sourceControl: { provider: "github", repository: "owner/repo", baseRef: "main" },
        execution: { provider: "exe.dev", tag: "tag" },
      }),
      /unknown fields/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("SDK maps provider-backed terminal failures without retaining its credential", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maquila-sdk-"));
  const credential = "sdk-openrouter-secret";
  const environment = { ...process.env };
  try {
    const maquila = createMaquila({
      workItemProvider: workItems,
      sourceControlProvider: sourceControl,
      executionProvider: execution,
      stateDirectory: directory,
      openRouterApiKey: credential,
    });
    const run = (id: string) =>
      maquila.run({
        workItem: { provider: "linear", id },
        sourceControl: { provider: "github", repository: "owner/repo", baseRef: "main" },
        execution: { provider: "exe.dev", tag: "test-tag" },
        mode: "dry-run",
      });
    const first = await run("ENG-1");
    const second = await run("ENG-2");
    assert.equal(first.status, "failed");
    assert.equal(second.status, "failed");
    assert.notEqual(first.runId, second.runId);
    assert.equal(first.runDirectory.startsWith(directory), true);
    assert.equal(JSON.stringify([first, second]).includes(credential), false);
    assert.equal(JSON.stringify(process.env), JSON.stringify(environment));
    assert.equal(
      everyFile(directory).some((path) => readFileSync(path, "utf8").includes(credential)),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("public entrypoint exports facade factories that compose built-in providers", () => {
  assert.equal(typeof createMaquila, "function");
  assert.equal(typeof createLinearWorkItemProvider, "function");
  assert.equal(typeof createGitHubSourceControlProvider, "function");
  assert.equal(typeof createExeExecutionProvider, "function");
  const directory = mkdtempSync(join(tmpdir(), "maquila-sdk-builtins-"));
  try {
    const maquila = createMaquila({
      workItemProvider: createLinearWorkItemProvider({ token: "linear-token" }),
      sourceControlProvider: createGitHubSourceControlProvider({ token: "github-token" }),
      executionProvider: createExeExecutionProvider({
        client: {
          async createVm() {
            return { vmName: "vm", status: "ready", sshDest: "user@host" };
          },
          async destroyVm() {
            return { destroyed: true, notFound: false };
          },
          async exec() {
            return { stdout: "", stderr: "" };
          },
          async execStream() {
            return { stderr: "" };
          },
          async copyTo() {
            return { stdout: "", stderr: "" };
          },
          async copyFrom() {
            return { stdout: "", stderr: "" };
          },
        },
      }),
      stateDirectory: directory,
      openRouterApiKey: "openrouter-token",
    });
    assert.equal(typeof maquila.run, "function");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI built-in composition keeps credentials out of references and uses project state", () => {
  const root = "/tmp/maquila-cli-target";
  const invocation = builtInMaquilaInvocation(
    root,
    { linearToken: "linear-secret", githubToken: "github-secret", openRouterKey: "router-secret" },
    {
      issue: "ENG-52",
      owner: "acme",
      repo: "widget",
      baseRef: "main",
      tag: "acme-widget",
      timeoutSeconds: 60,
    },
  );
  assert.deepEqual(invocation.request, {
    workItem: { provider: "linear", id: "ENG-52" },
    sourceControl: { provider: "github", repository: "acme/widget", baseRef: "main" },
    execution: { provider: "exe.dev", tag: "acme-widget" },
    timeoutSeconds: 60,
  });
  assert.equal(invocation.config.stateDirectory, resolve(root, ".maquila"));
  assert.equal(JSON.stringify(invocation.request).includes("secret"), false);
});
test("internal facade controls preserve a supplied run ID and accepted callback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maquila-sdk-internal-"));
  const runId = "11111111-1111-4111-8111-111111111111";
  let accepted = 0;
  try {
    const result = await runMaquila(
      {
        workItemProvider: workItems,
        sourceControlProvider: sourceControl,
        executionProvider: execution,
        stateDirectory: directory,
        openRouterApiKey: "key",
      },
      {
        workItem: { provider: "linear", id: "ENG-1" },
        sourceControl: { provider: "github", repository: "owner/repo", baseRef: "main" },
        execution: { provider: "exe.dev", tag: "tag" },
        mode: "dry-run",
      },
      { runId, maquilaRoot: process.cwd(), onAccepted: () => accepted++ },
    );
    assert.equal(result.runId, runId);
    assert.equal(result.status, "failed");
    assert.equal(result.runDirectory.startsWith(directory), true);
    assert.equal(accepted, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
