import { parseArgs } from "node:util";
import { parseAgentsCommand } from "./commands/agents.js";
import { parseObserverCommand, parseDashboardCommand } from "./commands/observer.js";
import { parsePiCommand } from "./commands/pi.js";
import { parseRunCommand } from "./commands/run.js";
import { parseSetupCommand, parseDoctorCommand } from "./commands/setup-doctor.js";
import { rejectOptions } from "./helpers.js";
import type { ParsedCli } from "./types.js";

export function parseCli(args: string[]): ParsedCli {
  const { positionals, values } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      issue: { type: "string" },
      planner: { type: "string" },
      "base-sha": { type: "string" },
      "timeout-seconds": { type: "string" },
      owner: { type: "string" },
      "base-ref": { type: "string" },
      tag: { type: "string" },
      identity: { type: "string" },
      machine: { type: "boolean" },
      target: { type: "string" },
      "run-id": { type: "string" },
      "resume-session": { type: "string" },
      "session-id": { type: "string" },
      "session-sha256": { type: "string" },
      "workflow-manifest": { type: "string" },
      json: { type: "boolean" },
      port: { type: "string" },
      "linear-token-reference": { type: "string" },
      "openrouter-token-reference": { type: "string" },
      "install-skill": { type: "boolean" },
    },
  });

  if (values.help) {
    rejectOptions(values, ["help"]);
    return "help";
  }

  const primary = positionals[0];
  const secondary = positionals[1];
  const command = positionals.join(" ");

  if (command === "setup") return parseSetupCommand(values);
  if (command === "doctor") return parseDoctorCommand(values);
  if (command === "agents list") return parseAgentsCommand(values);
  if (command === "dashboard") return parseDashboardCommand(values);

  if (primary === "observer") {
    if (!secondary) throw new Error("invalid observer command");
    return parseObserverCommand(secondary, values);
  }

  if (primary === "run") {
    return parseRunCommand(secondary, values);
  }

  if (primary === "pi") {
    if (!secondary) {
      throw new Error(
        "Expected command: agents list, setup, doctor, pi plan, pi worker, run, run start, run resume, run status, dashboard, or observer",
      );
    }
    return parsePiCommand(secondary, values);
  }

  throw new Error(
    "Expected command: agents list, setup, doctor, pi plan, pi worker, run, run start, run resume, run status, dashboard, or observer",
  );
}
