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
    rejectOptions(values, [
      "repo",
      "issue",
      "timeout-seconds",
      "machine",
      "resume-session",
      "session-id",
      "session-sha256",
    ]);
    if (typeof values.repo !== "string" || typeof values.issue !== "string")
      throw new Error("--repo, --issue are required");
    const resume = values["resume-session"];
    const sessionId = values["session-id"];
    const sessionSha256 = values["session-sha256"];
    const resumeSession =
      resume === undefined && sessionId === undefined && sessionSha256 === undefined
        ? undefined
        : typeof resume === "string" &&
            typeof sessionId === "string" &&
            typeof sessionSha256 === "string"
          ? { path: resume, sessionId, sha256: sessionSha256 }
          : (() => {
              throw new Error(
                "--resume-session, --session-id, and --session-sha256 must be provided together",
              );
            })();
    return {
      repo: values.repo,
      issue: values.issue,
      ...(resumeSession ? { resumeSession } : {}),
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
