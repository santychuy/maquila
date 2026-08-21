import { rejectOptions } from "../helpers.js";
import type { ParsedCli } from "../types.js";

export function parseAgentsCommand(values: Record<string, unknown>): ParsedCli {
  rejectOptions(values, []);
  return "list-agents";
}
