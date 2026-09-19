// PROTOTYPE: exercise guided setup without real credentials, network calls, or user config.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { loadMaquilaConfig } from "../src/config.js";
import type { DoctorCheck, DoctorOptions, DoctorResult } from "../src/doctor.js";
import { runSetup } from "../src/setup.js";

const root = mkdtempSync(resolve(tmpdir(), "maquila-setup-prototype-"));
const env = { XDG_CONFIG_HOME: root };

function mockedDoctor(options: DoctorOptions): DoctorResult {
  const source = options.env ?? env;
  const config = (options.loadConfig ?? loadMaquilaConfig)({ env: source, homedir: () => root });
  const checks: DoctorCheck[] = [
    { id: "config", status: "pass", message: "temporary maquila config valid" },
    { id: "target", status: "pass", message: "mock GitHub target resolved" },
    {
      id: "github",
      status: options.resolveGithub ? "fail" : "pass",
      message: "mock GitHub selection",
    },
    !options.resolveLinear && (source.LINEAR_API_TOKEN || config.linear)
      ? { id: "linear", status: "pass", message: "mock Linear credential resolves" }
      : { id: "linear", status: "fail", message: "mock Linear credential unavailable" },
    !options.resolveOpenRouter && (source.OPENROUTER_API_KEY || config.openrouter)
      ? { id: "openrouter", status: "pass", message: "mock OpenRouter credential resolves" }
      : { id: "openrouter", status: "fail", message: "mock OpenRouter credential unavailable" },
    { id: "models", status: "pass", message: "mock pinned models available" },
    { id: "ssh", status: options.listVms ? "fail" : "pass", message: "mock exe.dev selection" },
    { id: "cli", status: "pass", message: "mock maquila CLI available" },
    { id: "skill", status: "warn", message: "optional Pi skill not checked" },
  ];
  return { version: 1, ok: checks.every((check) => check.status !== "fail"), checks };
}

console.log("Maquila setup happy-path prototype");
console.log("GitHub and exe.dev are mocked as already connected.");
console.log(
  "Choose 1 to recheck GitHub/SSH. For Linear/OpenRouter: 1 paste, 2 env, 3 optional 1Password, 4 skip.",
);
console.log(
  "This prototype uses option 3 with a mock op:// reference. No real secrets or vendors are used.\n",
);

const readline = createInterface({ input: stdin, crlfDelay: Number.POSITIVE_INFINITY });
const answers = readline[Symbol.asyncIterator]();
try {
  const result = await runSetup({
    maquilaRoot: resolve(import.meta.dirname, ".."),
    env,
    homedir: () => root,
    stdinIsTTY: true,
    fromScratch: true,
    prompt: async (message) => {
      stdout.write(message);
      const answer = await answers.next();
      return answer.done ? "" : answer.value;
    },
    promptSecret: async () => "mock-pasted-key",
    runOp: async () => "mock-secret",
    runDoctor: async (options) => mockedDoctor(options),
  });
  console.log(`\nPrototype result: ${result.ok ? "ready" : "blocked"}`);
  process.exitCode = result.ok ? 0 : 1;
} finally {
  readline.close();
  rmSync(root, { recursive: true, force: true });
}
