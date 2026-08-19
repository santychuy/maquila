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
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(runDir, "issue.md"), issue, { mode: 0o600 });
  writeFileSync(resolve(runDir, "events.jsonl"), "", { mode: 0o600 });

  return {
    runId,
    runDir,
    sessionsDir,
    appendEvent(event) {
      appendFileSync(resolve(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, {
        mode: 0o600,
      });
    },
    write(name, content) {
      writeFileSync(resolve(runDir, name), content, { mode: 0o600 });
    },
    writeJson(name, value) {
      const target = resolve(runDir, name);
      const temporary = `${target}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, target);
    },
  };
}
