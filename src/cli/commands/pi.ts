import { parseTimeout, rejectOptions } from "../helpers.js";
import type { PlanCliOptions, WorkerCliOptions } from "../types.js";

export function parsePiCommand(
  subcommand: string,
  values: Record<string, unknown>,
): PlanCliOptions | WorkerCliOptions {
  if (subcommand === "worker") {
    rejectOptions(values, ["repo", "issue", "planner", "base-sha", "timeout-seconds", "machine"]);
    if (
      typeof values.repo !== "string" ||
      typeof values.issue !== "string" ||
      typeof values.planner !== "string" ||
      typeof values["base-sha"] !== "string"
    )
      throw new Error("--repo, --issue, --planner, --base-sha are required");
    return {
      repo: values.repo,
      issue: values.issue,
      plannerEnvelope: values.planner,
      baseSha: values["base-sha"],
      timeoutSeconds: parseTimeout(
        typeof values["timeout-seconds"] === "string" ? values["timeout-seconds"] : undefined,
        "300",
      ),
      ...(values.machine ? { machine: true } : {}),
    };
  }

  if (subcommand === "plan") {
    rejectOptions(values, ["repo", "issue", "timeout-seconds", "machine"]);
    if (typeof values.repo !== "string" || typeof values.issue !== "string")
      throw new Error("--repo, --issue are required");
    return {
      repo: values.repo,
      issue: values.issue,
      timeoutSeconds: parseTimeout(
        typeof values["timeout-seconds"] === "string" ? values["timeout-seconds"] : undefined,
        "300",
      ),
      ...(values.machine ? { machine: true } : {}),
    };
  }

  throw new Error(
    "Expected command: agents list, setup, doctor, pi plan, pi worker, run, run start, run status, dashboard, or observer",
  );
}
