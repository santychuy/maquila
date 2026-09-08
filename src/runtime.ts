import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const BUNFS = "/$bunfs/";
const PACKAGE_NAMES = new Set(["maquila", "@santychuy/maquila"]);

function packageRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    try {
      const value: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (
        typeof value === "object" &&
        value !== null &&
        "name" in value &&
        typeof value.name === "string" &&
        PACKAGE_NAMES.has(value.name)
      )
        return dir;
    } catch {
      /* keep searching */
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Locate the Maquila code/assets root, never the consumer repository. */
export function maquilaRoot(moduleDir: string): string {
  if (process.argv[1]?.startsWith(BUNFS)) return resolve(dirname(process.execPath), "..");
  const root = packageRoot(moduleDir) ?? packageRoot(dirname(moduleDir));
  if (!root) throw new Error("unable to locate Maquila package root");
  return root;
}

export function hostStateRoot(codeRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MAQUILA_HOME;
  if (explicit !== undefined) {
    if (
      !explicit.trim() ||
      explicit !== explicit.trim() ||
      Array.from(explicit).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      !isAbsolute(explicit) ||
      explicit !== resolve(explicit) ||
      explicit.includes("\0") ||
      explicit === "/"
    )
      throw new Error("MAQUILA_HOME must be a non-root absolute path");
    return explicit;
  }
  // Source/checkouts retain the historical .maquila location.
  if (existsSync(join(codeRoot, ".git"))) return codeRoot;
  const xdg = env.XDG_STATE_HOME;
  if (
    xdg !== undefined &&
    (!xdg.trim() ||
      xdg !== xdg.trim() ||
      Array.from(xdg).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      !isAbsolute(xdg) ||
      xdg !== resolve(xdg) ||
      xdg === "/")
  )
    throw new Error("XDG_STATE_HOME must be a normalized absolute path");
  const base = xdg ?? join(homedir(), ".local", "state");
  return join(base, "maquila");
}

export function cliInvocation(
  cliPath: string,
  args: string[],
  execPath = process.execPath,
): { command: string; args: string[] } {
  return cliPath.startsWith(BUNFS)
    ? { command: execPath, args }
    : { command: execPath, args: [resolve(cliPath), ...args] };
}
export function isMain(moduleUrl: string, argvPath = process.argv[1]): boolean {
  if (!argvPath) return false;
  if (argvPath.startsWith(BUNFS)) return true;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argvPath)).href;
  } catch {
    return false;
  }
}
