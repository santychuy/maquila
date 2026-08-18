#!/usr/bin/env node

import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { listAgents } from "./agents.js";
import { runPlan, type PlanOptions } from "./plan.js";
import { runWorkerLifecycle, type WorkerLifecycleOptions } from "./worker.js";
import { runController, type ControllerOptions } from "./controller.js";

export const HELP = `Usage:
  factory agents list
  factory pi plan --repo PATH --issue PATH --model PROVIDER/MODEL [--timeout-seconds 300]

Lists agents or runs planner, worker/reviewer, and remote controller workflows.
  factory pi worker --repo PATH --issue PATH --planner PATH --base-sha SHA --model PROVIDER/MODEL [--timeout-seconds 300]
  factory run --issue ID --owner OWNER --repo REPO --base-ref REF --tag TAG [--identity ABS] [--timeout-seconds 900]

`;

export function parseCli(
  args: string[],
):
  | PlanOptions
  | WorkerLifecycleOptions
  | Omit<ControllerOptions, "linearToken" | "githubToken">
  | "help"
  | "list-agents" {
  const { positionals, values } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      issue: { type: "string" },
      model: { type: "string" },
      planner: { type: "string" },
      "base-sha": { type: "string" },
      "timeout-seconds": { type: "string" },
      owner: { type: "string" },
      "base-ref": { type: "string" },
      tag: { type: "string" },
      identity: { type: "string" },
    },
  });

  if (values.help) return "help";
  if (positionals.join(" ") === "agents list") return "list-agents";
  if (positionals.join(" ") === "run") {
    if (!values.issue || !values.owner || !values.repo || !values["base-ref"] || !values.tag)
      throw new Error("--issue, --owner, --repo, --base-ref, and --tag are required");
    const timeoutSeconds = Number(values["timeout-seconds"] ?? "900");
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800)
      throw new Error("--timeout-seconds must be an integer from 1 to 1800");
    const identity = values.identity ?? process.env.FACTORY_EXE_IDENTITY;
    if (!identity) throw new Error("--identity or FACTORY_EXE_IDENTITY is required");
    if (!isAbsolute(identity) || identity.includes("\0")) {
      throw new Error("exe.dev identity must be an absolute path");
    }
    return {
      issue: values.issue,
      owner: values.owner,
      repo: values.repo,
      baseRef: values["base-ref"],
      tag: values.tag,
      identity,
      timeoutSeconds,
    };
  }
  if (positionals.join(" ") === "pi worker") {
    if (!values.repo || !values.issue || !values.model || !values.planner || !values["base-sha"])
      throw new Error("--repo, --issue, --planner, --base-sha, and --model are required");
    const timeoutSeconds = Number(values["timeout-seconds"] ?? "300");
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800)
      throw new Error("--timeout-seconds must be an integer from 1 to 1800");
    return {
      repo: values.repo,
      issue: values.issue,
      plannerEnvelope: values.planner,
      baseSha: values["base-sha"],
      model: values.model,
      timeoutSeconds,
    };
  }
  if (positionals.join(" ") !== "pi plan") {
    throw new Error("Expected command: agents list, pi plan, pi worker, or run");
  }
  if (!values.repo || !values.issue || !values.model) {
    throw new Error("--repo, --issue, and --model are required");
  }

  const timeoutSeconds = Number(values["timeout-seconds"] ?? "300");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1800) {
    throw new Error("--timeout-seconds must be an integer from 1 to 1800");
  }

  return {
    repo: values.repo,
    issue: values.issue,
    model: values.model,
    timeoutSeconds,
  };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseCli(args);
    if (options === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (options === "list-agents") {
      for (const agent of listAgents()) {
        process.stdout.write(
          `${agent.name}\t${agent.access}\t${agent.description}\t[${agent.tools.join(", ")}]\n`,
        );
      }
      return 0;
    }

    if ("identity" in options) {
      const linearToken = process.env.LINEAR_API_TOKEN;
      const githubToken = process.env.GITHUB_TOKEN;
      if (!linearToken || !githubToken)
        throw new Error("LINEAR_API_TOKEN and GITHUB_TOKEN are required");
      const result = await runController({ ...options, linearToken, githubToken });
      process.stdout.write(`\nController evidence: ${result.runDir}\n`);
      return result.status === "ready_for_publication" ? 0 : 1;
    }
    const result =
      "plannerEnvelope" in options ? await runWorkerLifecycle(options) : await runPlan(options);
    process.stdout.write(`\nRun evidence: ${result.runDir}\n`);
    if ("reviewerRunDir" in result && typeof result.reviewerRunDir === "string")
      process.stdout.write(`Reviewer evidence: ${result.reviewerRunDir}\n`);
    if (result.status === "timed_out") return 124;
    return result.status === "completed" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
