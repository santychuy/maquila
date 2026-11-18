import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Default exports of every .ts/.js file (not *.test.*) in `dir`. A missing dir is fine; a bad file is logged and skipped. */
export async function importAll(dir: string): Promise<{ file: string; value: unknown }[]> {
	const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /\.(ts|js)$/.test(f) && !/\.test\./.test(f)).sort();
	const out = [];
	for (const file of files) {
		try {
			out.push({ file, value: (await import(pathToFileURL(join(dir, file)).href)).default });
		} catch (error) {
			console.error(`[load ${file}]`, error);
		}
	}
	return out;
}
