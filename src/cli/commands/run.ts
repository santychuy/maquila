import { isAbsolute } from "node:path";
import { parseTimeout, rejectOptions } from "../helpers.js";
import type {
  DirectRunOptions,
  RunBatchCommand,
  RunBatchExecuteCommand,
  RunBatchStatusCommand,
  RunExecuteCommand,
  RunResumeCommand,
  RunStartCommand,
  RunStatusCommand,
} from "../types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type RunCommand =
  | DirectRunOptions
  | RunStartCommand
  | RunBatchCommand
  | RunBatchExecuteCommand
  | RunBatchStatusCommand
  | RunExecuteCommand
  | RunResumeCommand
  | RunStatusCommand;

function singleIssue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0];
  return undefined;
}

function batchIssues(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((issue) => typeof issue === "string")
    ? value
    : undefined;
}

export function parseRunCommand(
  subcommand: string | undefined,
  nested: string | undefined,
  values: Record<string, unknown>,
): RunCommand {
  if (subcommand === "start" && nested === undefined) {
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
    const issue = singleIssue(values.issue);
    if (!issue)
      throw new Error(
        values.issue === undefined ? "--issue is required" : "--issue must appear once",
      );
    return {
      command: "run-start",
      target: typeof values.target === "string" ? values.target : process.cwd(),
      issue,
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

  if (subcommand === "batch" && nested === "status") {
    rejectOptions(values, ["json", "batch-id"]);
    if (typeof values["batch-id"] !== "string" || !UUID.test(values["batch-id"]))
      throw new Error("invalid batch status --batch-id");
    return {
      command: "run-batch-status",
      batchId: values["batch-id"],
      ...(values.json ? { json: true } : {}),
    };
  }

  if (subcommand === "batch" && nested === "execute") {
    rejectOptions(values, ["batch-id"]);
    if (typeof values["batch-id"] !== "string" || !UUID.test(values["batch-id"]))
      throw new Error("invalid internal batch ID");
    return { command: "run-batch-execute", batchId: values["batch-id"] };
  }

  if (subcommand === "batch" && nested === undefined) {
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
    const issues = batchIssues(values.issue);
    if (
      !issues ||
      issues.length < 2 ||
      issues.length > 10 ||
      new Set(issues).size !== issues.length
    )
      throw new Error("batch requires 2 to 10 unique --issue values");
    return {
      command: "run-batch",
      target: typeof values.target === "string" ? values.target : process.cwd(),
      issues,
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

  if (subcommand === "execute" && nested === undefined) {
    rejectOptions(values, [
      "run-id",
      "issue",
      "owner",
      "repo",
      "base-ref",
      "tag",
      "timeout-seconds",
    ]);
    const issue = singleIssue(values.issue);
    if (
      typeof values["run-id"] !== "string" ||
      !issue ||
      typeof values.owner !== "string" ||
      typeof values.repo !== "string" ||
      typeof values["base-ref"] !== "string" ||
      typeof values.tag !== "string"
    )
      throw new Error("internal run execute arguments missing");
    return {
      command: "run-execute",
      runId: values["run-id"],
      issue,
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

  if (subcommand === "resume" && nested === undefined) {
    rejectOptions(values, ["json", "run-id", "identity"]);
    if (typeof values["run-id"] !== "string" || !UUID.test(values["run-id"]))
      throw new Error("invalid run resume --run-id");
    const identity =
      typeof values.identity === "string" ? values.identity : process.env.MAQUILA_EXE_IDENTITY;
    if (identity && (!isAbsolute(identity) || identity.includes("\0")))
      throw new Error("exe.dev identity must be an absolute path");
    return {
      command: "run-resume",
      runId: values["run-id"],
      ...(identity ? { identity } : {}),
      ...(values.json ? { json: true } : {}),
    };
  }

  if (subcommand === "status" && nested === undefined) {
    rejectOptions(values, ["json", "run-id"]);
    if (typeof values["run-id"] !== "string" || !values["run-id"])
      throw new Error("run status requires --run-id");
    return {
      command: "run-status",
      runId: values["run-id"],
      ...(values.json ? { json: true } : {}),
    };
  }

  if (subcommand === undefined && nested === undefined) {
    rejectOptions(values, [
      "issue",
      "owner",
      "repo",
      "base-ref",
      "tag",
      "identity",
      "timeout-seconds",
    ]);
    const issue = singleIssue(values.issue);
    if (
      !issue ||
      typeof values.owner !== "string" ||
      typeof values.repo !== "string" ||
      typeof values["base-ref"] !== "string" ||
      typeof values.tag !== "string"
    )
      throw new Error("--issue, --owner, --repo, --base-ref, and --tag are required");
    const identity =
      typeof values.identity === "string" ? values.identity : process.env.MAQUILA_EXE_IDENTITY;
    if (identity && (!isAbsolute(identity) || identity.includes("\0")))
      throw new Error("exe.dev identity must be an absolute path");
    return {
      issue,
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
    "Expected command: agents list, setup, doctor, pi plan, pi worker, run, run start, run batch, run resume, run status, dashboard, or observer",
  );
}
