import { rejectOptions } from "../helpers.js";
import type { SetupCommand, DoctorCommand } from "../types.js";

export function parseSetupCommand(values: Record<string, unknown>): SetupCommand {
  rejectOptions(values, [
    "json",
    "linear-token-reference",
    "openrouter-token-reference",
    "install-skill",
  ]);
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
  };
}

export function parseDoctorCommand(values: Record<string, unknown>): DoctorCommand {
  rejectOptions(values, ["json", "target"]);
  return {
    command: "doctor",
    target: typeof values.target === "string" ? values.target : process.cwd(),
    ...(values.json ? { json: true } : {}),
  };
}
