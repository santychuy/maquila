import { isAbsolute } from "node:path";
import { DEFAULT_REQUIRED_LABEL, validateDoctorIssueOptions } from "../../doctor.js";
import { rejectOptions } from "../helpers.js";
import type { SetupCommand, DoctorCommand } from "../types.js";

function identity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!isAbsolute(value) || value.includes("\0"))
    throw new Error("exe.dev identity must be an absolute path");
  return value;
}

export function parseSetupCommand(values: Record<string, unknown>): SetupCommand {
  if (values.agent && values.json) throw new Error("--agent cannot be combined with --json");
  if (values["from-scratch"] && values.json)
    throw new Error("--from-scratch cannot be combined with --json");
  if (values["from-scratch"] && values.agent)
    throw new Error("--from-scratch cannot be combined with --agent");
  for (const flag of ["linear-token-reference", "openrouter-token-reference", "install-skill"])
    if (values["from-scratch"] && values[flag])
      throw new Error(`--from-scratch cannot be combined with --${flag}`);
  rejectOptions(values, [
    "json",
    "agent",
    "from-scratch",
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
    ...(values.agent ? { agent: true } : {}),
    ...(values["from-scratch"] ? { fromScratch: true } : {}),
    target: typeof values.target === "string" ? values.target : process.cwd(),
    ...(parsedIdentity ? { identity: parsedIdentity } : {}),
  };
}
export function parseDoctorCommand(values: Record<string, unknown>): DoctorCommand {
  if (values.agent && values.json) throw new Error("--agent cannot be combined with --json");
  rejectOptions(values, ["json", "agent", "target", "identity", "issue", "require-label"]);
  const parsedIdentity = identity(values.identity);
  const issues = values.issue;
  if (issues !== undefined && (!Array.isArray(issues) || issues.length !== 1))
    throw new Error("doctor requires exactly one --issue");
  const issue: unknown = Array.isArray(issues) ? issues[0] : undefined;
  const rawLabel = values["require-label"];
  if (issue !== undefined && typeof issue !== "string") throw new Error("--issue must be a string");
  if (rawLabel !== undefined && typeof rawLabel !== "string")
    throw new Error("--require-label must be a string");
  // Label defaults to "maquila-ready"; pass --require-label "" to skip the label check.
  const requireLabel =
    typeof rawLabel === "string"
      ? rawLabel === ""
        ? undefined
        : rawLabel
      : issue !== undefined
        ? DEFAULT_REQUIRED_LABEL
        : undefined;
  validateDoctorIssueOptions({ issue, requireLabel });
  return {
    command: "doctor",
    target: typeof values.target === "string" ? values.target : process.cwd(),
    ...(values.json ? { json: true } : {}),
    ...(values.agent ? { agent: true } : {}),
    ...(parsedIdentity ? { identity: parsedIdentity } : {}),
    ...(issue !== undefined ? { issue } : {}),
    ...(requireLabel !== undefined ? { requireLabel } : {}),
  };
}
