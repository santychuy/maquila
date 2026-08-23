import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadMaquilaConfig } from "../src/config.js";
import { runController } from "../src/controller.js";
import { resolveGithubToken, resolveOpenRouterKey } from "../src/credentials.js";
import { fetchGitHubSnapshot } from "../src/integrations/github.js";
import type { LinearSnapshot } from "../src/integrations/linear.js";
import { createIntakeFromSnapshots } from "../src/intake.js";
import { readControllerState } from "../src/run-state.js";
import { validateResolvedTarget } from "../src/target.js";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    repo: { type: "string", default: "santychuy/maquila-e2e-fixture" },
    "base-ref": { type: "string", default: "main" },
    identity: { type: "string" },
    "timeout-seconds": { type: "string", default: "900" },
  },
  allowPositionals: false,
});
const [owner = "", repo = "", extra] = values.repo.split("/");
if (extra !== undefined) throw new Error("--repo must be OWNER/REPO");
const target = validateResolvedTarget({
  owner,
  repo,
  baseRef: values["base-ref"],
  tag: `${owner}-${repo}`,
});
const timeoutSeconds = Number(values["timeout-seconds"]);
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800)
  throw new Error("--timeout-seconds must be an integer from 1 to 1800");

const issueDescription = readFileSync(resolve(root, "examples/e2e-live/issue.md"), "utf8").trim();
const runId = randomUUID();
const issueValue = {
  uuid: runId,
  identifier: "E2E-1",
  title: "Add excited greeting mode",
  description: issueDescription,
  url: "https://linear.app/maquila/issue/E2E-1/live-happy-path",
  assignee: {
    id: "maquila-e2e-assignee",
    name: "Maquila E2E",
    url: "https://linear.app/maquila/profiles/e2e",
  },
  team: { id: "maquila-e2e-team", name: "Maquila E2E", key: "E2E" },
  state: { id: "maquila-e2e-todo", name: "Todo", type: "unstarted" },
  labels: [{ id: "maquila-e2e-label", name: "e2e" }],
};
const issue: LinearSnapshot = {
  ...issueValue,
  snapshotSha256: createHash("sha256").update(JSON.stringify(issueValue)).digest("hex"),
};
const env = process.env;
const config = loadMaquilaConfig({ env });
const [githubToken, openRouterKey] = await Promise.all([
  resolveGithubToken(env),
  resolveOpenRouterKey(env, config),
]);
const identity = values.identity ?? env.MAQUILA_EXE_IDENTITY;

process.stdout.write(
  `Live E2E run: ${runId}\nTarget: ${target.owner}/${target.repo}@${target.baseRef}\nStatus: maquila run status --run-id ${runId}\nDashboard: maquila dashboard\n\n`,
);

const result = await runController({
  issue: issue.identifier,
  owner: target.owner,
  repo: target.repo,
  baseRef: target.baseRef,
  tag: target.tag,
  timeoutSeconds,
  linearToken: "live-e2e-linear-token-unused",
  githubToken,
  openRouterKey,
  root,
  maquilaRoot: root,
  runId,
  publicationMode: "dry-run",
  intake: async (_linear, github) =>
    createIntakeFromSnapshots(issue, await fetchGitHubSnapshot(github)),
  createDecisionComment: async () => {
    throw new Error("live E2E scenario requires a planner-ready result; no Linear decision exists");
  },
  ...(identity ? { identity } : {}),
});

if (result.status !== "completed") throw new Error(result.error ?? `scenario ${result.status}`);
const state = readControllerState(result.runDir);
const patch = resolve(result.runDir, "change.patch");
const dryRun = resolve(result.runDir, "publication-dry-run.json");
if (state.cleanup !== "complete") throw new Error("scenario VM cleanup did not complete");
if (!existsSync(patch) || statSync(patch).size === 0) throw new Error("scenario patch is empty");
if (!existsSync(dryRun) || result.publicationDryRun?.mode !== "dry-run")
  throw new Error("scenario dry-run publication evidence is missing");

process.stdout.write(`Live E2E completed.\nEvidence: ${result.runDir}\nPatch: ${patch}\n`);
