import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseAgentDefinition, type AgentDefinition } from "./agents/index.js";

export interface RuntimeArchive {
  path: string;
  sha: string;
  cleanup(): void;
}
export interface RuntimeManifest {
  version: 1;
  maquilaSha: string;
  sha256: string;
}
const ROLES = ["planner", "worker", "documenter", "reviewer"] as const;
export type RuntimeRole = (typeof ROLES)[number];
export function isRuntimeRole(value: string): value is RuntimeRole {
  return ROLES.some((role) => role === value);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function regularFile(path: string, limit: number): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > limit)
    throw new Error("invalid runtime asset file");
}
export function runtimeArchiveSha256(archive: RuntimeArchive): string {
  regularFile(archive.path, MAX_ARCHIVE_BYTES);
  return createHash("sha256").update(readFileSync(archive.path)).digest("hex");
}
export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  if (!record(value)) throw new Error("invalid runtime manifest");
  const fields = value;
  if (
    Object.keys(fields).toSorted().join(",") !== "maquilaSha,sha256,version" ||
    fields.version !== 1 ||
    typeof fields.maquilaSha !== "string" ||
    !SHA.test(fields.maquilaSha) ||
    typeof fields.sha256 !== "string" ||
    !SHA256.test(fields.sha256)
  )
    throw new Error("invalid runtime manifest");
  return { version: 1, maquilaSha: fields.maquilaSha, sha256: fields.sha256 };
}
function verifyTar(path: string, sha: string): void {
  regularFile(path, MAX_ARCHIVE_BYTES);
  const options = { encoding: "utf8" as const, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 };
  const names = execFileSync("tar", ["-tf", path], options).trimEnd().split("\n");
  const forbidden = new Set([".git", "node_modules", "dist", ".maquila"]);
  if (
    !names.length ||
    names.length > 20_000 ||
    new Set(names).size !== names.length ||
    names.some((name) => {
      const parts = name.replace(/\/$/, "").split("/");
      return (
        !name ||
        name.startsWith("/") ||
        name.includes("\\") ||
        Array.from(name).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        parts.some((part) => !part || part === "." || part === ".." || forbidden.has(part))
      );
    })
  )
    throw new Error("unsafe runtime archive path");
  const members = execFileSync("tar", ["-tvf", path], options).trimEnd().split("\n");
  if (members.length !== names.length || members.some((line) => !/^[d-]/.test(line)))
    throw new Error("unsafe runtime archive member");
  // Git reads only the leading archive metadata. A file descriptor avoids EPIPE
  // when it exits before a large stdin buffer has finished being written.
  const input = openSync(path, "r");
  let embedded: string;
  try {
    embedded = execFileSync("git", ["get-tar-commit-id"], {
      stdio: [input, "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 1024,
      timeout: 10_000,
    }).trim();
  } finally {
    closeSync(input);
  }
  if (!SHA.test(embedded) || embedded !== sha) throw new Error("runtime source identity mismatch");
}

/** Build from this exact checkout, never an ancestor consumer repository. */
export function archiveMaquila(root: string): RuntimeArchive {
  const directory = mkdtempSync(resolve(tmpdir(), "maquila-runtime-"));
  const path = resolve(directory, "runtime.tar");
  try {
    const git = { cwd: root, encoding: "utf8" as const, timeout: 30_000 };
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], git).trim();
    if (realpathSync(top) !== realpathSync(root)) throw new Error("refusing consumer Git root");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], git).trim();
    if (!SHA.test(sha)) throw new Error("invalid source commit SHA");
    // CLAUDE.md is a tracked documentation symlink to AGENTS.md, not a runtime input.
    // Exclude that alias rather than accepting archive links that can escape extraction.
    execFileSync(
      "git",
      ["archive", "--format=tar", `--output=${path}`, sha, "--", ".", ":(exclude)CLAUDE.md"],
      git,
    );
    verifyTar(path, sha);
    chmodSync(path, 0o600);
    return { path, sha, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Snapshot and validate a packaged or retained archive before reading or uploading it. */
export function verifiedRuntimeArchive(path: string, value: unknown): RuntimeArchive {
  const manifest = parseRuntimeManifest(value);
  regularFile(path, MAX_ARCHIVE_BYTES);
  const directory = mkdtempSync(resolve(tmpdir(), "maquila-runtime-"));
  const snapshot = resolve(directory, "runtime.tar");
  const archive = {
    path: snapshot,
    sha: manifest.maquilaSha,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
  try {
    copyFileSync(path, snapshot, constants.COPYFILE_EXCL);
    chmodSync(snapshot, 0o600);
    if (runtimeArchiveSha256(archive) !== manifest.sha256)
      throw new Error("runtime archive hash mismatch");
    verifyTar(snapshot, manifest.maquilaSha);
    return archive;
  } catch (error) {
    archive.cleanup();
    throw error;
  }
}
export function runtimeArchive(root: string): RuntimeArchive {
  // Only a local Git marker selects checkout mode. An ancestor's .git is never authority.
  let checkout = false;
  try {
    lstatSync(resolve(root, ".git"));
    checkout = true;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
      throw error;
  }
  if (checkout) return archiveMaquila(root);
  const metadata = resolve(root, "dist/runtime/runtime.json");
  regularFile(metadata, 4096);
  const manifest: unknown = JSON.parse(readFileSync(metadata, "utf8"));
  return verifiedRuntimeArchive(resolve(root, "dist/runtime/runtime.tar"), manifest);
}
export function readArchivedRoleSource(archive: RuntimeArchive, role: RuntimeRole): string {
  if (!ROLES.includes(role)) throw new Error("unsupported runtime role");
  return execFileSync("tar", ["-xOf", archive.path, `src/agents/${role}.md`], {
    encoding: "utf8",
    maxBuffer: MAX_PROMPT_BYTES,
    timeout: 10_000,
  });
}
export function readArchivedRole(archive: RuntimeArchive, role: RuntimeRole): AgentDefinition {
  const definition = parseAgentDefinition(
    readArchivedRoleSource(archive, role),
    `src/agents/${role}.md`,
  );
  if (definition.name !== role) throw new Error("runtime role identity mismatch");
  return definition;
}
