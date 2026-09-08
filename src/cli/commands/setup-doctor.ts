import { isAbsolute } from "node:path";
import { validateDoctorIssueOptions } from "../../doctor.js";
import { rejectOptions } from "../helpers.js";
import type { SetupCommand, DoctorCommand } from "../types.js";

function identity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!isAbsolute(value) || value.includes("\0"))
    throw new Error("exe.dev identity must be an absolute path");
  return value;
}

export function parseSetupCommand(values: Record<string, unknown>): SetupCommand {
  rejectOptions(values, [
    "json",
    "linear-token-reference",
    "openrouter-token-reference",
    "install-skill",
    "target",
    "identity",
  ]);
  const parsedIdentity = identity(values.identity);
  return {
    command: "setup",
    ...(values.json ? { json: true } : {}),
    ...(typeof values["linear-token-reference"] === "string"
      ? { linearTokenReference: values["linear-token-reference"] }
      : {}),
    ...(typeof values["openrouter-token-reference"] === "string"
      ? { openRouterTokenReference: values["openrouter-token-reference"] }
      : {}),
    ...(values["install-skill"] ? { installSkill: true } : {}),
    ...(typeof values.target === "string" ? { target: values.target } : {}),
    ...(parsedIdentity ? { identity: parsedIdentity } : {}),
  };
}
export function parseDoctorCommand(values: Record<string, unknown>): DoctorCommand {
  rejectOptions(values, ["json", "target", "identity", "issue", "require-label"]);
  const parsedIdentity = identity(values.identity);
  const issues = values.issue;
  if (issues !== undefined && (!Array.isArray(issues) || issues.length !== 1))
    throw new Error("doctor requires exactly one --issue");
  const issue: unknown = Array.isArray(issues) ? issues[0] : undefined;
  const requireLabel = values["require-label"];
  if (issue !== undefined && typeof issue !== "string") throw new Error("--issue must be a string");
  if (requireLabel !== undefined && typeof requireLabel !== "string")
    throw new Error("--require-label must be a string");
  validateDoctorIssueOptions({ issue, requireLabel });
  return {
    command: "doctor",
    target: typeof values.target === "string" ? values.target : process.cwd(),
    ...(values.json ? { json: true } : {}),
    ...(parsedIdentity ? { identity: parsedIdentity } : {}),
    ...(issue !== undefined ? { issue } : {}),
    ...(requireLabel !== undefined ? { requireLabel } : {}),
  };
}
