import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";

// Test a source snapshot in a temporary Git repository. Never commit the real checkout.
const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(resolve(tmpdir(), "maquila-package-check-"));
const source = resolve(temporary, "source");
const consumer = resolve(temporary, "consumer");
const runtime = resolve(temporary, "remote-runtime");
const home = resolve(temporary, "home");
const bun = process.execPath;
const env = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: resolve(home, "config"),
  XDG_STATE_HOME: resolve(home, "state"),
  HUSKY: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}
try {
  for (const path of [source, consumer, runtime, home]) mkdirSync(path, { recursive: true });
  const files = [
    "package.json",
    "bun.lock",
    "tsconfig.json",
    ".gitignore",
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
  ];
  for (const path of [...files, "src", "scripts", "test", ".pi/skills/maquila"]) {
    if (!existsSync(resolve(root, path))) throw new Error(`package fixture input missing: ${path}`);
    mkdirSync(resolve(source, path, ".."), { recursive: true });
    cpSync(resolve(root, path), resolve(source, path), { recursive: true });
  }
  run("git", ["init", "-q"], source);
  // Git's directory-only ignore does not cover the fixture dependency symlink.
  writeFileSync(resolve(source, ".git/info/exclude"), "node_modules\n");
  symlinkSync(resolve(root, "node_modules"), resolve(source, "node_modules"), "dir");
  run(bun, ["run", "build:observer"], source);
  run("git", ["add", "."], source);
  run(
    "git",
    [
      "-c",
      "user.name=Maquila package test",
      "-c",
      "user.email=package-test@example.invalid",
      "commit",
      "-qm",
      "Package test source snapshot",
    ],
    source,
  );
  console.log("Building a clean temporary source snapshot...");
  run(bun, ["run", "build:package"], source);
  const tarball = resolve(temporary, "candidate.tgz");
  run(bun, ["pm", "pack", "--ignore-scripts", "--filename", tarball, "--quiet"], source);
  const members = run("tar", ["-tzf", tarball], temporary).trim().split("\n");
  for (const required of [
    "package/LICENSE",
    "package/THIRD_PARTY_NOTICES.md",
    "package/dist/src/index.js",
    "package/dist/src/index.d.ts",
    "package/dist/src/cli/index.js",
    "package/src/agents/planner.md",
    "package/.pi/skills/maquila/SKILL.md",
    "package/dist/runtime/runtime.tar",
    "package/dist/runtime/runtime.json",
  ])
    assert.ok(members.includes(required), `missing package asset: ${required}`);
  assert.equal(
    members.some(
      (path) =>
        /(?:^|\/)(?:node_modules|\.git|\.maquila)(?:\/|$)/.test(path) ||
        path.startsWith("package/dist/test/") ||
        path === "package/dist/maquila" ||
        path.endsWith(".map"),
    ),
    false,
  );
  const metadata = JSON.parse(readFileSync(resolve(source, "package.json"), "utf8"));
  writeFileSync(
    resolve(consumer, "package.json"),
    JSON.stringify({
      name: "maquila-package-consumer",
      private: true,
      type: "module",
      dependencies: { [metadata.name]: `file:${tarball}` },
    }),
  );
  console.log("Installing the packed artifact into a fresh consumer...");
  run(bun, ["install", "--ignore-scripts"], consumer);
  const installed = resolve(consumer, "node_modules", metadata.name);
  assert.equal(realpathSync(installed).startsWith(realpathSync(consumer)), true);
  assert.equal(existsSync(resolve(installed, ".git")), false);
  assert.match(
    run("node", [resolve(installed, "dist/src/cli/index.js"), "--help"], consumer),
    /maquila run start/,
  );
  assert.match(
    run(resolve(consumer, "node_modules/.bin/maquila"), ["agents", "list"], consumer),
    /planner/,
  );
  const probe = resolve(consumer, "probe.mjs");
  writeFileSync(
    probe,
    `import assert from "node:assert/strict";
import { createMaquila, createLinearWorkItemProvider } from ${JSON.stringify(metadata.name)};
import { runtimeArchive, readArchivedRole } from ${JSON.stringify(resolve(installed, "dist/src/runtime-archive.js"))};
import { hostStateRoot } from ${JSON.stringify(resolve(installed, "dist/src/runtime.js"))};
import { runSetup } from ${JSON.stringify(resolve(installed, "dist/src/setup.js"))};
assert.equal(typeof createMaquila, "function");
assert.equal(typeof createLinearWorkItemProvider, "function");
assert.equal(hostStateRoot(${JSON.stringify(installed)}), ${JSON.stringify(resolve(home, "state/maquila"))});
const archive = runtimeArchive(${JSON.stringify(installed)});
try { assert.equal(readArchivedRole(archive, "planner").name, "planner"); } finally { archive.cleanup(); }
for (let i=0;i<2;i++) {
 const result = await runSetup({ maquilaRoot: ${JSON.stringify(installed)}, installSkill: true, json: true, homedir: () => ${JSON.stringify(home)}, env: {}, runDoctor: async () => ({ version: 1, ok: true, checks: [] }), write: () => {} });
 assert.equal(result.ok, true);
}
const { writeFileSync } = await import("node:fs");
const { createObserverServer } = await import(${JSON.stringify(resolve(installed, "dist/src/observer/server.js"))});
const unreachable = async () => { throw new Error("unexpected provider call"); };
const factory = createMaquila({
 workItemProvider: { fetchWorkItem: async () => { throw new Error("controlled offline intake failure"); }, requestDecision: unreachable, waitForDecision: unreachable },
 sourceControlProvider: { fetchSourceControl: unreachable, cloneUrl: () => "", dryRunPublication: () => { throw new Error("unexpected publication"); }, publishReviewedPatch: unreachable },
 executionProvider: { createVm: unreachable, destroyVm: unreachable, exec: unreachable, execStream: unreachable, copyTo: unreachable, copyFrom: unreachable },
 stateDirectory: ${JSON.stringify(resolve(home, "state/maquila/.maquila"))}, openRouterApiKey: "unused-fixture-key",
});
const result = await factory.run({ workItem: { provider: "linear", id: "TEST-1" }, sourceControl: { provider: "github", repository: "fixture/repo", baseRef: "main" }, execution: { provider: "exe.dev", tag: "fixture" }, mode: "dry-run" });
assert.equal(result.status, "failed");
writeFileSync(${JSON.stringify(resolve(consumer, "run-result.json"))}, JSON.stringify(result));
const observer = await createObserverServer({ root: ${JSON.stringify(resolve(home, "state/maquila"))}, port: 0, instanceId: "33333333-3333-4333-8333-333333333333" });
try {
 const response = await fetch(observer.descriptor.url + "/api/v1/runs/" + result.runId);
 assert.equal(response.status, 200);
 const status = await response.json();
 assert.equal(status.runId, result.runId);
 assert.equal(status.status, "failed");
} finally { await observer.close(); }
console.log("Installed SDK, runtime, state root, repeat setup, and observer passed");
`,
  );
  console.log(run("node", [probe], consumer).trim());
  const offlineRun = JSON.parse(readFileSync(resolve(consumer, "run-result.json"), "utf8"));
  const cliStatus = JSON.parse(
    run(
      "node",
      [
        resolve(installed, "dist/src/cli/index.js"),
        "run",
        "status",
        "--run-id",
        offlineRun.runId,
        "--json",
      ],
      consumer,
    ),
  );
  assert.equal(cliStatus.status, "failed");
  assert.equal(cliStatus.runId, offlineRun.runId);
  assert.equal(existsSync(resolve(installed, ".maquila")), false);
  assert.equal(existsSync(resolve(consumer, ".maquila")), false);
  // Exercise doctor JSON without any vendor connection or credential resolution.
  const shims = resolve(temporary, "shims");
  mkdirSync(shims);
  for (const name of ["ssh", "gh"]) {
    const path = resolve(shims, name);
    writeFileSync(path, "#!/usr/bin/env node\nprocess.exit(1);\n");
    chmodSync(path, 0o755);
  }
  const preload = resolve(consumer, "offline.mjs");
  writeFileSync(
    preload,
    'globalThis.fetch = async () => { throw new Error("network disabled by package check"); };\n',
  );
  let doctorOutput = "";
  try {
    execFileSync(
      "node",
      [
        "--import",
        preload,
        resolve(installed, "dist/src/cli/index.js"),
        "doctor",
        "--target",
        consumer,
        "--json",
      ],
      {
        cwd: consumer,
        env: { ...env, PATH: `${shims}${delimiter}${env.PATH}` },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    throw new Error("doctor unexpectedly reported readiness without credentials");
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("status" in error) ||
      error.status !== 1 ||
      !("stdout" in error) ||
      typeof error.stdout !== "string"
    )
      throw error;
    doctorOutput = error.stdout;
  }
  assert.equal(JSON.parse(doctorOutput).ok, false);
  assert.equal(
    JSON.parse(doctorOutput).checks.find((check: { id: string }) => check.id === "cli").status,
    "pass",
  );
  console.log("Building the shipped runtime in a fresh directory without Git metadata...");
  run("tar", ["-xf", resolve(installed, "dist/runtime/runtime.tar"), "-C", runtime], temporary);
  run(bun, ["install", "--frozen-lockfile", "--ignore-scripts"], runtime);
  run(bun, ["run", "build"], runtime);
  assert.match(run(resolve(runtime, "dist/maquila"), ["--help"], runtime), /maquila run start/);
  console.log(
    "PASS: packed files, clean install, SDK, CLI, offline doctor, setup, and remote-runtime build. No VM or vendor workflow started.",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
