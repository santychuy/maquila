import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("built SDK declarations type-check a consumer through the package exports", () => {
  const root = resolve(import.meta.dirname, "../..");
  assert.equal(existsSync(join(root, "dist/src/index.d.ts")), true);
  const directory = mkdtempSync(join(tmpdir(), "maquila-sdk-types-"));
  try {
    mkdirSync(join(directory, "node_modules/@santychuy"), { recursive: true });
    symlinkSync(root, join(directory, "node_modules/@santychuy/maquila"), "dir");
    writeFileSync(
      join(directory, "consumer.mts"),
      `import {
  createMaquila,
  createLinearWorkItemProvider,
  createGitHubSourceControlProvider,
  createExeExecutionProvider,
  type MaquilaRunRequest,
  type MaquilaRunResult,
  type EventSink,
} from "@santychuy/maquila";
// @ts-expect-error Internal controller controls are not public exports.
import { runMaquila } from "@santychuy/maquila";

const sink: EventSink = { async emit(record) { void record; } };
const instance = createMaquila({
  workItemProvider: createLinearWorkItemProvider({ token: "unused" }),
  sourceControlProvider: createGitHubSourceControlProvider({ token: "unused" }),
  executionProvider: createExeExecutionProvider(),
  eventSink: sink,
  stateDirectory: "/unused/type-check-only",
  openRouterApiKey: "unused",
});
const request: MaquilaRunRequest = {
  workItem: { provider: "linear", id: "ENG-1" },
  sourceControl: { provider: "github", repository: "owner/repo", baseRef: "main" },
  execution: { provider: "exe.dev", tag: "fixture" },
  mode: "dry-run",
};
const result: Promise<MaquilaRunResult> = instance.run(request);
void result;
// @ts-expect-error Requests cannot carry credentials.
request.openRouterApiKey = "not-allowed";
// @ts-expect-error The SDK does not expose detached controller methods.
instance.start(request);
`,
    );
    // Compile only: the consumer must never execute providers or start a VM.
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2024",
        join(directory, "consumer.mts"),
      ],
      { cwd: directory, encoding: "utf8", timeout: 30_000 },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
