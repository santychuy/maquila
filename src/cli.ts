#!/usr/bin/env node

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { listAgents } from "./agents.js";
import { runPlan, type PlanOptions } from "./plan.js";
import { runWorkerLifecycle, type WorkerLifecycleOptions } from "./worker.js";

export const HELP = `Usage:
  factory agents list
  factory pi plan --repo PATH --issue PATH --model PROVIDER/MODEL [--timeout-seconds 300]

Lists validated specialist definitions, runs read-only planner, or runs worker/reviewer lifecycle.
  factory pi worker --repo PATH --issue PATH --planner PATH --base-sha SHA --model PROVIDER/MODEL [--timeout-seconds 300]

`;

export function parseCli(
  args: string[],
): PlanOptions | WorkerLifecycleOptions | "help" | "list-agents" {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      issue: { type: "string" },
      model: { type: "string" },
      planner: { type: "string" },
      "base-sha": { type: "string" },
      "timeout-seconds": { type: "string", default: "300" },
    },
  });

  if (values.help) return "help";
  if (positionals.join(" ") === "agents list") return "list-agents";
  if (positionals.join(" ") === "pi worker") {
    if (!values.repo || !values.issue || !values.model || !values.planner || !values["base-sha"])
      throw new Error("--repo, --issue, --planner, --base-sha, and --model are required");
    const timeoutSeconds = Number(values["timeout-seconds"]);
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
    throw new Error("Expected command: agents list, pi plan, or pi worker");
  }
  if (!values.repo || !values.issue || !values.model) {
    throw new Error("--repo, --issue, and --model are required");
  }

  const timeoutSeconds = Number(values["timeout-seconds"]);
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
