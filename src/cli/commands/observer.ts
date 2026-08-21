import { parseObserverPort, rejectOptions } from "../helpers.js";
import type { ObserverServeCommand, ObserverReadCommand } from "../types.js";

export function parseDashboardCommand(values: Record<string, unknown>): ObserverServeCommand {
  rejectOptions(values, ["port"]);
  return {
    command: "dashboard",
    port: parseObserverPort(typeof values.port === "string" ? values.port : undefined),
  };
}

export function parseObserverCommand(
  subcommand: string,
  values: Record<string, unknown>,
): ObserverServeCommand | ObserverReadCommand {
  if (subcommand === "serve") {
    rejectOptions(values, ["port"]);
    return {
      command: "observer-serve",
      port: parseObserverPort(typeof values.port === "string" ? values.port : undefined),
    };
  }
  if (subcommand === "ensure") {
    rejectOptions(values, ["json", "port"]);
    if (!values.json) throw new Error("observer ensure requires --json");
    return {
      command: "observer-ensure",
      port: parseObserverPort(typeof values.port === "string" ? values.port : undefined),
    };
  }
  if (subcommand === "status") {
    rejectOptions(values, ["json"]);
    if (!values.json) throw new Error("observer status requires --json");
    return { command: "observer-status" };
  }
  if (subcommand === "stop") {
    rejectOptions(values, ["json"]);
    if (!values.json) throw new Error("observer stop requires --json");
    return { command: "observer-stop" };
  }
  throw new Error("invalid observer command");
}
