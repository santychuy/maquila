import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BUNFS = "/$bunfs/";

export function factoryRoot(moduleDir: string): string {
  if (process.argv[1]?.startsWith(BUNFS)) return resolve(dirname(process.execPath), "..");
  const sourceRoot = resolve(moduleDir, "..");
  return existsSync(resolve(sourceRoot, "package.json")) ? sourceRoot : resolve(moduleDir, "../..");
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
