import { isAbsolute } from "node:path";
import { parseTimeout, rejectOptions } from "../helpers.js";
import type {
  DirectRunOptions,
  RunExecuteCommand,
  RunStartCommand,
  RunStatusCommand,
} from "../types.js";

export function parseRunCommand(
  subcommand: string | undefined,
  values: Record<string, unknown>,
): DirectRunOptions | RunStartCommand | RunExecuteCommand | RunStatusCommand {
  if (subcommand === "start") {
    rejectOptions(values, [
      "json",
      "target",
      "issue",
      "owner",
      "repo",
      "base-ref",
      "tag",
      "identity",
      "timeout-seconds",
    ]);
    if (!values.issue || typeof values.issue !== "string") throw new Error("--issue is required");
    return {
      command: "run-start",
      target: typeof values.target === "string" ? values.target : process.cwd(),
      issue: values.issue,
      timeoutSeconds: parseTimeout(
        typeof values["timeout-seconds"] === "string" ? values["timeout-seconds"] : undefined,
        "900",
      ),
      ...(typeof values.owner === "string" ? { owner: values.owner } : {}),
      ...(typeof values.repo === "string" ? { repo: values.repo } : {}),
      ...(typeof values["base-ref"] === "string" ? { baseRef: values["base-ref"] } : {}),
      ...(typeof values.tag === "string" ? { tag: values.tag } : {}),
      ...(typeof values.identity === "string" ? { identity: values.identity } : {}),
      ...(values.json ? { json: true } : {}),
    };
  }

  if (subcommand === "execute") {
    rejectOptions(values, [
      "run-id",
      "issue",
      "owner",
      "repo",
      "base-ref",
      "tag",
      "timeout-seconds",
    ]);
    if (
      typeof values["run-id"] !== "string" ||
      typeof values.issue !== "string" ||
      typeof values.owner !== "string" ||
      typeof values.repo !== "string" ||
      typeof values["base-ref"] !== "string" ||
      typeof values.tag !== "string"
    )
      throw new Error("internal run execute arguments missing");
    return {
      command: "run-execute",
      runId: values["run-id"],
      issue: values.issue,
      owner: values.owner,
      repo: values.repo,
      baseRef: values["base-ref"],
      tag: values.tag,
      timeoutSeconds: parseTimeout(
        typeof values["timeout-seconds"] === "string" ? values["timeout-seconds"] : undefined,
        "900",
      ),
    };
  }

  if (subcommand === "status") {
    rejectOptions(values, ["json", "run-id"]);
    if (typeof values["run-id"] !== "string" || !values["run-id"])
      throw new Error("run status requires --run-id");
    return {
      command: "run-status",
      runId: values["run-id"],
      ...(values.json ? { json: true } : {}),
    };
  }

  if (subcommand === undefined) {
    rejectOptions(values, [
      "issue",
      "owner",
      "repo",
      "base-ref",
      "tag",
      "identity",
      "timeout-seconds",
    ]);
    if (
      typeof values.issue !== "string" ||
      typeof values.owner !== "string" ||
      typeof values.repo !== "string" ||
      typeof values["base-ref"] !== "string" ||
      typeof values.tag !== "string"
    )
      throw new Error("--issue, --owner, --repo, --base-ref, and --tag are required");
    const identity =
      typeof values.identity === "string" ? values.identity : process.env.FACTORY_EXE_IDENTITY;
    if (identity && (!isAbsolute(identity) || identity.includes("\0")))
      throw new Error("exe.dev identity must be an absolute path");
    return {
      issue: values.issue,
      owner: values.owner,
      repo: values.repo,
      baseRef: values["base-ref"],
      tag: values.tag,
      timeoutSeconds: parseTimeout(
        typeof values["timeout-seconds"] === "string" ? values["timeout-seconds"] : undefined,
        "900",
      ),
      ...(identity ? { identity } : {}),
    };
  }

  throw new Error(
    "Expected command: agents list, setup, doctor, pi plan, pi worker, run, run start, run status, dashboard, or observer",
  );
}
