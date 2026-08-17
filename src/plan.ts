import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadAgent } from "./agents.js";
import { renderPlannerPlan } from "./envelope.js";
import { runAgent, type AgentRunStatus } from "./run-agent.js";
import { createRunArtifacts } from "./run-artifacts.js";

export const MAX_TIMEOUT_SECONDS = 1800;

export interface PlanOptions {
  repo: string;
  issue: string;
  model: string;
  timeoutSeconds: number;
}

export type PlanStatus = AgentRunStatus;

export interface PlanResult {
  runDir: string;
  status: PlanStatus;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}

function validateFile(path: string): void {
  if (!statSync(path).isFile()) throw new Error(`Not a file: ${path}`);
}

function validateRepo(path: string): void {
  if (!statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`);
  git(path, "rev-parse", "--is-inside-work-tree");
}

export async function runPlan(options: PlanOptions): Promise<PlanResult> {
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 1 || options.timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`);
  }

  const repo = resolve(options.repo);
  const issuePath = resolve(options.issue);
  validateRepo(repo);
  validateFile(issuePath);

  const issue = readFileSync(issuePath, "utf8");
  const planner = loadAgent("planner");
  const artifacts = createRunArtifacts(issue);

  const result = await runAgent({
    agent: planner,
    cwd: repo,
    model: options.model,
    timeoutSeconds: options.timeoutSeconds,
    prompt: `Plan this issue. Do not modify the repository.\n\n${issue}`,
    artifacts,
    envelopeRole: "planner",
    receiptContext: {
      repo,
      baseSha: git(repo, "rev-parse", "HEAD"),
      repoWasDirty: git(repo, "status", "--porcelain").length > 0,
      issueSha256: createHash("sha256").update(issue).digest("hex"),
    },
    onTextDelta: (delta) => process.stdout.write(delta),
    onCompleted: (_finalText, target, envelope) => {
      if (!envelope || !("changes" in envelope)) throw new Error("Planner completed without a valid planner envelope");
      target.write("plan.md", `${renderPlannerPlan(envelope)}\n`);
      return ["plan.md"];
    },
  });

  return { runDir: result.runDir, status: result.status };
}
