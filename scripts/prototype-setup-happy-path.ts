// PROTOTYPE: exercise guided setup without real credentials, network calls, or user config.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { loadMaquilaConfig } from "../src/config.js";
import type { DoctorCheck, DoctorResult } from "../src/doctor.js";
import { runSetup } from "../src/setup.js";

const root = mkdtempSync(resolve(tmpdir(), "maquila-setup-prototype-"));
const env = { XDG_CONFIG_HOME: root };

function mockedDoctor(): DoctorResult {
  const config = loadMaquilaConfig({ env, homedir: () => root });
  const checks: DoctorCheck[] = [
    { id: "config", status: "pass", message: "temporary maquila config valid" },
    { id: "target", status: "pass", message: "mock GitHub target resolved" },
    { id: "github", status: "pass", message: "mock GitHub target/base read succeeded" },
    config.linear
      ? { id: "linear", status: "pass", message: "mock Linear credential resolves" }
      : { id: "linear", status: "fail", message: "mock Linear credential unavailable" },
    config.openrouter
      ? { id: "openrouter", status: "pass", message: "mock OpenRouter credential resolves" }
      : { id: "openrouter", status: "fail", message: "mock OpenRouter credential unavailable" },
    { id: "models", status: "pass", message: "mock pinned models available" },
    { id: "ssh", status: "pass", message: "mock exe.dev VM list succeeded" },
    { id: "cli", status: "pass", message: "mock maquila CLI available" },
    { id: "skill", status: "warn", message: "optional Pi skill not checked" },
  ];
  return { version: 1, ok: checks.every((check) => check.status !== "fail"), checks };
}

console.log("Maquila setup happy-path prototype");
console.log("GitHub and exe.dev are mocked as already connected.");
console.log("Enter example op:// references; no real secret is read or stored.\n");

const readline = createInterface({ input: stdin, crlfDelay: Number.POSITIVE_INFINITY });
const answers = readline[Symbol.asyncIterator]();
try {
  const result = await runSetup({
    maquilaRoot: resolve(import.meta.dirname, ".."),
    env,
    homedir: () => root,
    stdinIsTTY: true,
    prompt: async (message) => {
      stdout.write(message);
      const answer = await answers.next();
      return answer.done ? "" : answer.value;
    },
    runOp: async () => "mock-secret",
    runDoctor: async () => mockedDoctor(),
  });
  console.log(`\nPrototype result: ${result.ok ? "ready" : "blocked"}`);
  process.exitCode = result.ok ? 0 : 1;
} finally {
  readline.close();
  rmSync(root, { recursive: true, force: true });
}
