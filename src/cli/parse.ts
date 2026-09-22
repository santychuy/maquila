import { parseArgs } from "node:util";
import { parseAgentsCommand } from "./commands/agents.js";
import { parseObserverCommand, parseDashboardCommand } from "./commands/observer.js";
import { parsePiCommand } from "./commands/pi.js";
import { parseRunCommand } from "./commands/run.js";
import { parseSetupCommand, parseDoctorCommand } from "./commands/setup-doctor.js";
import { rejectOptions } from "./helpers.js";
import type { ParsedCli } from "./types.js";

function parseControllerTtl(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("invalid controller TTL");
  const match = /^(\d+)(m|h|d|w)$/.exec(value);
  if (!match) throw new Error("controller TTL must use m, h, d, or w");
  const amount = Number(match[1]);
  const unit = match[2]!;
  const seconds = amount * { m: 60, h: 3600, d: 86_400, w: 604_800 }[unit]!;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 365 * 24 * 60 * 60)
    throw new Error("controller TTL must be between 1 minute and 365 days");
  return seconds;
}

export function parseCli(args: string[]): ParsedCli {
  const { positionals, values } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      issue: { type: "string", multiple: true },
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
      "batch-id": { type: "string" },
      "resume-session": { type: "string" },
      "session-id": { type: "string" },
      "session-sha256": { type: "string" },
      "workflow-manifest": { type: "string" },
      json: { type: "boolean" },
      port: { type: "string" },
      agent: { type: "boolean" },
      "from-scratch": { type: "boolean" },
      "linear-token-reference": { type: "string" },
      "openrouter-token-reference": { type: "string" },
      "install-skill": { type: "boolean" },
      "require-label": { type: "string" },
      "poll-interval-ms": { type: "string" },
      "automatic-admission": { type: "boolean" },
      "controller-name": { type: "string" },
      "allow-credential-transfer": { type: "boolean" },
      ttl: { type: "string" },
    },
  });

  if (values.help) {
    rejectOptions(values, ["help"]);
    return "help";
  }

  const primary = positionals[0];
  const secondary = positionals[1];
  const tertiary = positionals[2];
  const command = positionals.join(" ");

  if (command === "intake deploy") {
    rejectOptions(values, [
      "target",
      "port",
      "controller-name",
      "identity",
      "json",
      "ttl",
      "allow-credential-transfer",
    ]);
    if (typeof values.target !== "string" || !values["allow-credential-transfer"])
      throw new Error("intake deploy requires --target and --allow-credential-transfer");
    const port = Number(values.port ?? "8080");
    const controllerName = values["controller-name"] ?? "maquila-controller";
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      typeof controllerName !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(controllerName)
    )
      throw new Error("invalid intake deploy options");
    return {
      command: "intake-deploy",
      target: values.target,
      controllerName,
      port,
      allowCredentialTransfer: true,
      ...(values.ttl === undefined ? {} : { ttlSeconds: parseControllerTtl(values.ttl) }),
      ...(typeof values.identity === "string" ? { identity: values.identity } : {}),
      ...(values.json ? { json: true } : {}),
    };
  }
  if (command === "intake expire") {
    rejectOptions(values, []);
    return { command: "intake-expire" };
  }
  if (command === "intake status" || command === "intake destroy") {
    rejectOptions(values, ["identity", "json"]);
    return {
      command: command === "intake status" ? "intake-status" : "intake-destroy",
      ...(typeof values.identity === "string" ? { identity: values.identity } : {}),
      ...(values.json ? { json: true } : {}),
    };
  }
  if (command === "intake serve") {
    rejectOptions(values, ["target", "port", "poll-interval-ms"]);
    if (typeof values.target !== "string" || typeof values.port !== "string")
      throw new Error("intake serve requires --target and --port");
    const port = Number(values.port);
    const pollMilliseconds = Number(values["poll-interval-ms"] ?? "60000");
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !Number.isInteger(pollMilliseconds) ||
      pollMilliseconds < 1000
    )
      throw new Error("invalid intake serve options");
    return {
      command: "intake-serve",
      target: values.target,
      port,
      pollMilliseconds,
    };
  }
  if (command === "setup") return parseSetupCommand(values);
  if (command === "doctor") return parseDoctorCommand(values);
  if (command === "agents list") return parseAgentsCommand(values);
  if (command === "dashboard") return parseDashboardCommand(values);

  if (primary === "observer") {
    if (!secondary) throw new Error("invalid observer command");
    return parseObserverCommand(secondary, values);
  }

  if (primary === "run") {
    if (positionals.length > 3) throw new Error("invalid run command");
    return parseRunCommand(secondary, tertiary, values);
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
