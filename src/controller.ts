import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { createIntake } from "./intake.js";
import { parseEnvelope } from "./envelope.js";
import { ExeClient } from "./exe.js";
import {
  createControllerState,
  recordControllerCleanup,
  recordControllerVm,
  recoverStaleControllerClaims,
  scanRecoverableControllerStates,
  transitionControllerState,
  type ControllerState,
} from "./run-state.js";
import { acquireControllerLock } from "./controller-lock.js";

const MODEL = "exe/claude-sonnet-4-6";
const REMOTE_FACTORY = "/home/exedev/factory";
const REMOTE_WORK = "/home/exedev/work";
const REMOTE_NODE = "/home/exedev/.local/node/bin/node";
const REMOTE_NPM = "/home/exedev/.local/node/bin/npm";
const REMOTE_COREPACK = "/home/exedev/.local/node/bin/corepack";
const REMOTE_BUN = "/home/exedev/.local/bun/bin/bun";
const REMOTE_PATH =
  "/home/exedev/.local/bun/bin:/home/exedev/.local/node/bin:/usr/local/bin:/usr/bin:/bin";
const NODE_VERSION = "24.15.0";
const BUN_VERSION = "1.3.14";
const NODE_CHECKSUMS: Record<string, string> = {
  x64: "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6",
  arm64: "f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0",
};
const MAX_PATCH = 1_000_000;
const REMOTE_RUN = `${REMOTE_FACTORY}/.factory/runs/`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ControllerOptions {
  issue: string;
  owner: string;
  repo: string;
  baseRef: string;
  tag: string;
  identity: string;
  timeoutSeconds: number;
  linearToken: string;
  githubToken: string;
  root?: string;
  factoryRoot?: string;
  exe?: ControllerExe;
  intake?: typeof createIntake;
  sleep?: (milliseconds: number) => Promise<void>;
}
export interface ControllerExe {
  createVm(options: {
    name: string;
    tag: string;
    integration?: string;
  }): Promise<{ vmName: string; status: string; sshDest: string }>;
  destroyVm(name: string): Promise<{ destroyed: boolean; notFound: boolean }>;
  exec(
    destination: string,
    argv: string[],
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string }>;
  copyTo(destination: string, localPath: string, remotePath: string): Promise<unknown>;
  copyFrom(destination: string, remotePath: string, localPath: string): Promise<unknown>;
}
export interface ControllerResult {
  status: "ready_for_publication" | "failed";
  runDir: string;
  error?: string;
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function requireAbsolute(path: string): string {
  if (!isAbsolute(path)) throw new Error("identity must be absolute");
  return path;
}
function vmName(runId: string): string {
  return `factory-${runId.replaceAll("-", "").slice(0, 24)}`;
}
function outputPath(output: string, label: string): string {
  const line = output
    .split("\n")
    .toReversed()
    .find((value) => value.startsWith(`${label}: `));
  const path = line?.slice(label.length + 2).trim();
  if (!path?.startsWith(REMOTE_RUN) || !UUID.test(path.slice(REMOTE_RUN.length))) {
    throw new Error(`remote ${label.toLowerCase()} missing`);
  }
  return path;
}
function json(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeRepo(owner: string, repo: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error("invalid repository");
  return `${owner}/${repo}`;
}
function redact(value: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value);
}
function writeJson(path: string, value: object): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
function readdirArtifacts(runDir: string): string[] {
  return readdirSync(runDir);
}
export function harvest(archive: string, runDir: string, runs: string[]): void {
  const names = execFileSync("tar", ["-tf", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  if (
    !names.length ||
    names.some(
      (name) => !name.startsWith(".factory/runs/") || name.includes("..") || name.startsWith("/"),
    )
  )
    throw new Error("unsafe evidence archive path");
  const verbose = execFileSync("tar", ["-tvf", archive], { encoding: "utf8" });
  if (verbose.split("\n").some((line) => /^[lhbcps]/.test(line)))
    throw new Error("unsafe evidence archive member");
  const target = resolve(runDir, "remote-evidence");
  mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xf", archive, "-C", target]);
  for (const run of runs) {
    if (!UUID.test(run)) throw new Error("unsafe remote run id");
  }
  const required = [
    [runs[0], "receipt.json"],
    [runs[0], "envelope.json"],
    [runs[0], "plan.md"],
    [runs[1], "receipt.json"],
    [runs[1], "lifecycle.json"],
    [runs[1], "verification.json"],
    [runs[2], "receipt.json"],
    [runs[2], "envelope.json"],
  ];
  for (const [run, file] of required)
    if (!existsSync(resolve(target, ".factory", "runs", run!, file!)))
      throw new Error("required remote evidence missing");
  const planner = parseEnvelope(
    "planner",
    json(resolve(target, ".factory", "runs", runs[0]!, "envelope.json")),
  );
  const worker = json(resolve(target, ".factory", "runs", runs[1]!, "lifecycle.json"));
  const verification = json(resolve(target, ".factory", "runs", runs[1]!, "verification.json"));
  const reviewer = parseEnvelope(
    "reviewer",
    json(resolve(target, ".factory", "runs", runs[2]!, "envelope.json")),
  );
  if (
    !planner.ok ||
    planner.envelope.decisionsNeeded.length > 0 ||
    !isRecord(worker) ||
    worker.status !== "completed" ||
    !isRecord(verification) ||
    verification.passed !== true ||
    !reviewer.ok ||
    reviewer.envelope.verdict !== "PASS"
  ) {
    throw new Error("remote lifecycle did not pass");
  }
  const manifest: Record<string, string> = {};
  for (const name of names) {
    const path = resolve(target, name);
    if (existsSync(path) && statSync(path).isFile()) manifest[name] = hash(path);
  }
  writeJson(resolve(runDir, "evidence-manifest.json"), manifest);
}
function transition(
  runDir: string,
  next: Parameters<typeof transitionControllerState>[1],
): ControllerState {
  return transitionControllerState(runDir, next);
}

function archiveFactory(factoryRoot: string): { path: string; sha: string; cleanup(): void } {
  const directory = mkdtempSync(resolve(tmpdir(), "factory-runtime-"));
  const path = resolve(directory, "runtime.tar");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: factoryRoot,
    encoding: "utf8",
  }).trim();
  const data = execFileSync("git", ["archive", "--format=tar", "HEAD"], { cwd: factoryRoot });
  writeFileSync(path, data, { mode: 0o600 });
  return { path, sha, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

async function remote(
  exe: ControllerExe,
  destination: string,
  argv: string[],
  timeout: number,
): Promise<string> {
  return (await exe.exec(destination, argv, timeout)).stdout;
}
const CAPTURE = `import{spawn}from'node:child_process';const a=JSON.parse(process.argv[2]);let o='',e='',done=false;const add=(s,x)=>(s+String(x)).slice(-1048576);const finish=(code,signal)=>{if(done)return;done=true;process.stdout.write(JSON.stringify({code,signal,stdout:o,stderr:e}))};const p=spawn(a[0],a.slice(1),{stdio:['ignore','pipe','pipe']});p.stdout.on('data',x=>o=add(o,x));p.stderr.on('data',x=>e=add(e,x));p.on('error',x=>{e=add(e,x);finish(1,null)});p.on('close',(code,signal)=>finish(code??1,signal));`;
async function captured(
  exe: ControllerExe,
  destination: string,
  argv: string[],
  timeout: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await remote(
    exe,
    destination,
    [REMOTE_NODE, "/home/exedev/capture.mjs", JSON.stringify(argv)],
    timeout,
  );
  const value: unknown = JSON.parse(result);
  if (
    !isRecord(value) ||
    typeof value.code !== "number" ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string"
  )
    throw new Error("invalid remote capture result");
  return { code: value.code, stdout: value.stdout, stderr: value.stderr };
}

async function recover(root: string, exe: ControllerExe): Promise<void> {
  const controllers = resolve(root, ".factory", "controllers");
  if (!existsSync(controllers)) return;
  recoverStaleControllerClaims(controllers);
  for (const state of scanRecoverableControllerStates(controllers)) {
    const runDir = resolve(controllers, state.runId);
    const name =
      state.vm?.name ?? (state.state === "creating_vm" ? vmName(state.runId) : undefined);
    if (!name) {
      transition(runDir, "failed");
      continue;
    }
    const result = await exe.destroyVm(name);
    if (!result.destroyed && !result.notFound)
      throw new Error("controller recovery cleanup failed");
    if (state.vm) recordControllerCleanup(runDir, "complete");
    transition(runDir, "failed");
  }
}

export async function runController(options: ControllerOptions): Promise<ControllerResult> {
  if (
    !Number.isInteger(options.timeoutSeconds) ||
    options.timeoutSeconds < 1 ||
    options.timeoutSeconds > 1800
  )
    throw new Error("timeoutSeconds must be an integer from 1 to 1800");
  if (!options.linearToken.trim()) throw new Error("Linear token missing");
  if (!options.githubToken.trim()) throw new Error("GitHub token missing");
  requireAbsolute(options.identity);
  safeRepo(options.owner, options.repo);
  const root = resolve(options.root ?? process.cwd());
  const factoryRoot = resolve(options.factoryRoot ?? process.cwd());
  const exe = options.exe ?? new ExeClient(undefined, 30_000, options.identity);
  const lock = acquireControllerLock(root);
  const runId = randomUUID();
  const provisional = resolve(root, ".factory", "attempts", runId);
  const startedAt = new Date().toISOString();
  try {
    mkdirSync(provisional, { recursive: true });
    writeJson(resolve(provisional, "receipt.json"), {
      kind: "controller",
      status: "failed",
      startedAt,
      artifacts: ["receipt.json"],
    });
  } catch (error) {
    lock.release();
    throw error;
  }
  let evidenceDir = provisional;
  let state: ControllerState | undefined;
  let archive: ReturnType<typeof archiveFactory> | undefined;
  let failure: string | undefined;
  let cleanupFailed = false;
  let stage = "recovery";
  try {
    await recover(root, exe);
    stage = "intake";
    const intake = await (options.intake ?? createIntake)(
      { token: options.linearToken, issue: options.issue },
      {
        token: options.githubToken,
        owner: options.owner,
        repo: options.repo,
        baseRef: options.baseRef,
      },
    );
    const runDir = resolve(root, ".factory", "controllers", runId);
    writeFileSync(
      resolve(provisional, "issue.md"),
      `${intake.issue.title}\n\n${intake.issue.description}\n`,
      { mode: 0o600 },
    );
    writeJson(resolve(provisional, "intake.json"), {
      issue: intake.issue,
      repository: intake.repository,
      idempotencyKey: intake.idempotencyKey,
    });
    stage = "state";
    state = createControllerState(runDir, {
      runId: basename(runDir),
      idempotencyKey: intake.idempotencyKey,
      issueUuid: intake.issue.uuid,
      issueSnapshotSha256: intake.issue.snapshotSha256,
      repositoryId: intake.repository.repositoryId,
      repositoryFullName: intake.repository.fullName,
      repositorySnapshotSha256: intake.repository.snapshotSha256,
      baseRef: intake.repository.baseRef,
      baseSha: intake.repository.baseSha,
    });
    for (const name of ["receipt.json", "issue.md", "intake.json"]) {
      renameSync(resolve(provisional, name), resolve(runDir, name));
    }
    rmSync(provisional, { recursive: true, force: true });
    evidenceDir = runDir;
    transition(runDir, "creating_vm");
    stage = "creating_vm";
    const vm = await exe.createVm({ name: vmName(state.runId), tag: options.tag });
    state = recordControllerVm(runDir, { name: vm.vmName, sshDest: vm.sshDest, status: vm.status });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await remote(exe, vm.sshDest, ["true"], 30_000);
        break;
      } catch (error) {
        if (attempt === 11) throw error;
        await (
          options.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)))
        )(5_000);
      }
    }
    transition(runDir, "bootstrapping");
    stage = "bootstrapping";
    await remote(
      exe,
      vm.sshDest,
      ["git", "clone", `https://github.int.exe.xyz/${state.repositoryFullName}.git`, REMOTE_WORK],
      120_000,
    );
    await remote(
      exe,
      vm.sshDest,
      ["git", "-C", REMOTE_WORK, "checkout", "--detach", state.baseSha],
      30_000,
    );
    if (
      (
        await remote(exe, vm.sshDest, ["git", "-C", REMOTE_WORK, "rev-parse", "HEAD"], 30_000)
      ).trim() !== state.baseSha
    )
      throw new Error("remote checkout SHA mismatch");
    archive = archiveFactory(factoryRoot);
    writeJson(resolve(runDir, "runtime.json"), {
      factorySha: archive.sha,
      sha256: hash(archive.path),
    });
    const configDir = mkdtempSync(resolve(tmpdir(), "factory-pi-"));
    const models = resolve(configDir, "models.json");
    const capture = resolve(configDir, "capture.mjs");
    writeFileSync(capture, CAPTURE, { mode: 0o600 });
    writeJson(models, {
      providers: {
        exe: {
          baseUrl: "https://llm.int.exe.xyz",
          api: "anthropic-messages",
          apiKey: "implicit",
          models: [
            {
              id: "claude-sonnet-4-6",
              reasoning: true,
              input: ["text"],
              contextWindow: 200000,
              maxTokens: 16384,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              compat: { forceAdaptiveThinking: true },
            },
          ],
        },
      },
    });
    try {
      const machine = (await remote(exe, vm.sshDest, ["uname", "-m"], 30_000)).trim();
      const nodeArch = machine === "x86_64" ? "x64" : machine === "aarch64" ? "arm64" : "";
      const checksum = NODE_CHECKSUMS[nodeArch];
      if (!checksum) throw new Error("unsupported exe.dev architecture");
      const nodeArchive = `/home/exedev/node-v${NODE_VERSION}-linux-${nodeArch}.tar.xz`;
      await remote(
        exe,
        vm.sshDest,
        [
          "mkdir",
          "-p",
          REMOTE_FACTORY,
          "/home/exedev/.pi/agent",
          "/home/exedev/.local/node",
          "/home/exedev/.local/bun",
        ],
        30_000,
      );
      await remote(
        exe,
        vm.sshDest,
        [
          "curl",
          "-fsSLo",
          nodeArchive,
          `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${nodeArch}.tar.xz`,
        ],
        120_000,
      );
      const actualChecksum = (await remote(exe, vm.sshDest, ["sha256sum", nodeArchive], 30_000))
        .trim()
        .split(/\s+/, 1)[0];
      if (actualChecksum !== checksum) throw new Error("Node.js archive checksum mismatch");
      await remote(
        exe,
        vm.sshDest,
        ["tar", "-xJf", nodeArchive, "-C", "/home/exedev/.local/node", "--strip-components=1"],
        60_000,
      );
      await remote(
        exe,
        vm.sshDest,
        [
          "env",
          `PATH=${REMOTE_PATH}`,
          REMOTE_NPM,
          "install",
          "--global",
          "--prefix",
          "/home/exedev/.local/bun",
          `bun@${BUN_VERSION}`,
        ],
        180_000,
      );
      const bunVersion = (await remote(exe, vm.sshDest, [REMOTE_BUN, "--version"], 30_000)).trim();
      if (bunVersion !== BUN_VERSION) throw new Error("unexpected Bun version");
      writeJson(resolve(runDir, "bootstrap.json"), {
        nodeVersion: NODE_VERSION,
        nodeArch,
        nodeSha256: checksum,
        bunVersion,
      });
      await exe.copyTo(vm.sshDest, archive.path, "/home/exedev/runtime.tar");
      await exe.copyTo(vm.sshDest, models, "/home/exedev/.pi/agent/models.json");
      await exe.copyTo(vm.sshDest, capture, "/home/exedev/capture.mjs");
      await remote(
        exe,
        vm.sshDest,
        ["tar", "-xf", "/home/exedev/runtime.tar", "-C", REMOTE_FACTORY],
        60_000,
      );
      await remote(exe, vm.sshDest, [REMOTE_NODE, "--version"], 30_000);
      await remote(
        exe,
        vm.sshDest,
        [
          "env",
          "-C",
          REMOTE_FACTORY,
          `PATH=${REMOTE_PATH}`,
          REMOTE_COREPACK,
          "pnpm",
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
        ],
        300_000,
      );
      await remote(
        exe,
        vm.sshDest,
        [
          "env",
          "-C",
          REMOTE_FACTORY,
          `PATH=${REMOTE_PATH}`,
          REMOTE_COREPACK,
          "pnpm",
          "run",
          "build",
        ],
        120_000,
      );
      await remote(
        exe,
        vm.sshDest,
        [
          "env",
          "-C",
          REMOTE_WORK,
          `PATH=${REMOTE_PATH}`,
          "BUN_INSTALL=/home/exedev/.local/bun",
          REMOTE_BUN,
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
        ],
        600_000,
      );
      await remote(
        exe,
        vm.sshDest,
        ["curl", "-fsS", "-o", "/dev/null", "https://llm.int.exe.xyz/v1/models"],
        30_000,
      );
      transition(runDir, "planning");
      stage = "planning";
      const issue = "/home/exedev/issue.md";
      await exe.copyTo(vm.sshDest, resolve(runDir, "issue.md"), issue);
      const plannerResult = await captured(
        exe,
        vm.sshDest,
        [
          "env",
          "-C",
          REMOTE_FACTORY,
          `PATH=${REMOTE_PATH}`,
          REMOTE_NODE,
          "dist/src/cli.js",
          "pi",
          "plan",
          "--repo",
          REMOTE_WORK,
          "--issue",
          issue,
          "--model",
          MODEL,
          "--timeout-seconds",
          String(options.timeoutSeconds),
        ],
        options.timeoutSeconds * 1000 + 60_000,
      );
      const plannerOutput = plannerResult.stdout;
      const plannerRun = outputPath(plannerOutput, "Run evidence");
      if (plannerResult.code !== 0) throw new Error("remote planner failed");
      const plannerEnvelope = JSON.parse(
        await remote(exe, vm.sshDest, ["cat", `${plannerRun}/envelope.json`], 30_000),
      ) as unknown;
      const parsedPlan = parseEnvelope("planner", plannerEnvelope);
      if (!parsedPlan.ok || parsedPlan.envelope.decisionsNeeded.length)
        throw new Error("remote planner envelope is blocked");
      transition(runDir, "implementing");
      stage = "implementing";
      const workerResult = await captured(
        exe,
        vm.sshDest,
        [
          "env",
          "-C",
          REMOTE_FACTORY,
          `PATH=${REMOTE_PATH}`,
          REMOTE_NODE,
          "dist/src/cli.js",
          "pi",
          "worker",
          "--repo",
          REMOTE_WORK,
          "--issue",
          issue,
          "--planner",
          `${plannerRun}/envelope.json`,
          "--base-sha",
          state.baseSha,
          "--model",
          MODEL,
          "--timeout-seconds",
          String(options.timeoutSeconds),
        ],
        options.timeoutSeconds * 3000 + 120_000,
      );
      const workerOutput = workerResult.stdout;
      const workerRun = outputPath(workerOutput, "Run evidence");
      if (workerResult.code !== 0) throw new Error("remote worker lifecycle failed");
      const reviewerRun = outputPath(workerOutput, "Reviewer evidence");
      transition(runDir, "verifying");
      transition(runDir, "reviewing");
      stage = "harvesting";
      const patch = await remote(
        exe,
        vm.sshDest,
        ["git", "-C", REMOTE_WORK, "add", "-A"],
        30_000,
      ).then(() =>
        remote(
          exe,
          vm.sshDest,
          ["git", "-C", REMOTE_WORK, "diff", "--cached", "--binary", "--no-ext-diff", "HEAD"],
          60_000,
        ),
      );
      if (!patch || Buffer.byteLength(patch) > MAX_PATCH)
        throw new Error("change patch missing or exceeds limit");
      writeFileSync(resolve(runDir, "change.patch"), patch, { mode: 0o600 });
      await remote(
        exe,
        vm.sshDest,
        ["tar", "-cf", "/home/exedev/evidence.tar", "-C", REMOTE_FACTORY, ".factory/runs"],
        60_000,
      );
      await exe.copyFrom(vm.sshDest, "/home/exedev/evidence.tar", resolve(runDir, "evidence.tar"));
      if (statSync(resolve(runDir, "evidence.tar")).size > 50 * 1024 * 1024)
        throw new Error("evidence archive exceeds limit");
      const runIds = [plannerRun, workerRun, reviewerRun].map((path) => basename(path));
      harvest(resolve(runDir, "evidence.tar"), runDir, runIds);
      writeJson(resolve(runDir, "remote-runs.json"), { plannerRun, workerRun, reviewerRun });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (!state && evidenceDir !== provisional && existsSync(evidenceDir)) {
      renameSync(evidenceDir, provisional);
      evidenceDir = provisional;
    }
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure && state?.vm) {
    const runDir = resolve(root, ".factory", "controllers", state.runId);
    const target = resolve(runDir, "failure-evidence.tar");
    try {
      await remote(
        exe,
        state.vm.sshDest,
        ["tar", "-cf", "/home/exedev/evidence.tar", "-C", REMOTE_FACTORY, ".factory/runs"],
        60_000,
      );
      await exe.copyFrom(state.vm.sshDest, "/home/exedev/evidence.tar", target);
      if (statSync(target).size > 50 * 1024 * 1024) {
        rmSync(target, { force: true });
        throw new Error("failure evidence archive exceeds limit");
      }
    } catch {}
  }
  try {
    if (state) {
      const cleaned = await exe.destroyVm(state.vm?.name ?? vmName(state.runId));
      if (cleaned.destroyed || cleaned.notFound) {
        if (state.vm) {
          recordControllerCleanup(
            resolve(root, ".factory", "controllers", state.runId),
            "complete",
          );
        }
      } else {
        throw new Error("VM cleanup failed");
      }
    }
  } catch (error) {
    cleanupFailed = true;
    if (!failure) stage = "cleanup";
    if (state?.vm) {
      try {
        recordControllerCleanup(resolve(root, ".factory", "controllers", state.runId), "failed");
      } catch {}
    }
    failure ??= error instanceof Error ? error.message : String(error);
  }
  try {
    archive?.cleanup();
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error);
  }

  let result: ControllerResult;
  try {
    const runDir = state ? resolve(root, ".factory", "controllers", state.runId) : evidenceDir;
    if (!state || failure) {
      if (state && !cleanupFailed) transition(runDir, "failed");
      const error = redact(failure ?? "intake failed", [options.linearToken, options.githubToken]);
      writeJson(resolve(runDir, "receipt.json"), {
        kind: "controller",
        status: "failed",
        stage,
        startedAt,
        finishedAt: new Date().toISOString(),
        cleanup: state?.vm ? (cleanupFailed ? "failed" : "complete") : "not-needed",
        artifacts: readdirArtifacts(runDir),
        error,
      });
      result = { status: "failed", runDir, error };
    } else {
      transition(runDir, "ready_for_publication");
      writeJson(resolve(runDir, "receipt.json"), {
        kind: "controller",
        status: "ready_for_publication",
        stage: "ready_for_publication",
        startedAt,
        finishedAt: new Date().toISOString(),
        cleanup: "complete",
        artifacts: readdirArtifacts(runDir),
      });
      result = { status: "ready_for_publication", runDir };
    }
  } finally {
    lock.release();
  }
  return result;
}
