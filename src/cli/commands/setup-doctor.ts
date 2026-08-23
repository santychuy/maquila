import { isAbsolute } from "node:path";
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
  rejectOptions(values, ["json", "target", "identity"]);
  const parsedIdentity = identity(values.identity);
  return {
    command: "doctor",
    target: typeof values.target === "string" ? values.target : process.cwd(),
    ...(values.json ? { json: true } : {}),
    ...(parsedIdentity ? { identity: parsedIdentity } : {}),
  };
}
