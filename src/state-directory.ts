import { resolve } from "node:path";

/** Returns the legacy host-state directory for a project root. */
export function stateDirectory(root: string): string {
  return resolve(root, ".maquila");
}

/** Resolves a host-state path from an exact state directory, without adding a suffix. */
export function statePath(stateDirectoryPath: string, ...parts: string[]): string {
  return resolve(stateDirectoryPath, ...parts);
}
