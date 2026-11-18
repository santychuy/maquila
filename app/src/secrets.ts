import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const NAME = /^[A-Z_][A-Z0-9_]*$/;
const MAX_VALUE = 8 * 1024;
const lineName = (line: string) => /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1];
const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

async function readLines(path: string): Promise<string[]> {
	try {
		return (await readFile(path, "utf8")).split("\n").filter((l) => l !== "");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** Names set in a systemd EnvironmentFile; never the values. */
export async function loadSecretNames(path: string): Promise<string[]> {
	return (await readLines(path)).map(lineName).filter((n): n is string => n !== undefined);
}

/** Set (string) or remove (null / "") names in the env file. Values are written raw, so unsafe ones are rejected. */
export async function applySecrets(path: string, updates: Record<string, string | null>): Promise<void> {
	const entries = Object.entries(updates);
	for (const [name, value] of entries) {
		if (!NAME.test(name)) throw bad(`Invalid name "${name}": use A-Z, 0-9 and _`);
		if (value === null || value === "") continue;
		if (typeof value !== "string") throw bad(`${name} must be a string or null`);
		if (value.length > MAX_VALUE) throw bad(`${name} is too long (max 8 KiB)`);
		if (/[\r\n]/.test(value)) throw bad(`${name} must not contain newlines`);
		if (/["'\\]/.test(value) || value !== value.trim()) {
			throw bad(`${name} must not contain quotes or backslashes, or leading/trailing spaces`);
		}
	}
	const lines = (await readLines(path)).filter((l) => !entries.some(([n]) => lineName(l) === n));
	for (const [name, value] of entries) if (value) lines.push(`${name}=${value}`);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, lines.join("\n") + (lines.length ? "\n" : ""), { mode: 0o600 });
	await chmod(path, 0o600); // mode only applies on create
}
