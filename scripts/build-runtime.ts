import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { archiveMaquila, runtimeArchiveSha256 } from "../src/runtime-archive.js";

const root = resolve(import.meta.dirname, "..");
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
  cwd: root,
  encoding: "utf8",
  timeout: 30_000,
});
if (dirty.trim())
  throw new Error("refusing runtime build: commit or remove all source changes first");
const archive = archiveMaquila(root);
try {
  const output = resolve(root, "dist/runtime");
  mkdirSync(output, { recursive: true });
  copyFileSync(archive.path, resolve(output, "runtime.tar"));
  writeFileSync(
    resolve(output, "runtime.json"),
    `${JSON.stringify(
      {
        version: 1,
        maquilaSha: archive.sha,
        sha256: runtimeArchiveSha256(archive),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  archive.cleanup();
}
