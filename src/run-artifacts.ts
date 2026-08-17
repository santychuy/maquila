import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface RunArtifacts {
  runId: string;
  runDir: string;
  sessionsDir: string;
  appendEvent(event: object): void;
  write(name: string, content: string): void;
  writeJson(name: string, value: object): void;
}

export function createRunArtifacts(issue: string, root = process.cwd()): RunArtifacts {
  const runId = randomUUID();
  const runDir = resolve(root, ".factory", "runs", runId);
  const sessionsDir = resolve(runDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(resolve(runDir, "issue.md"), issue);
  writeFileSync(resolve(runDir, "events.jsonl"), "");

  return {
    runId,
    runDir,
    sessionsDir,
    appendEvent(event) {
      appendFileSync(resolve(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`);
    },
    write(name, content) {
      writeFileSync(resolve(runDir, name), content);
    },
    writeJson(name, value) {
      const target = resolve(runDir, name);
      const temporary = `${target}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
      renameSync(temporary, target);
    },
  };
}
