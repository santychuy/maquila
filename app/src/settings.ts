import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type Settings = { provider?: Provider; model?: string; apiKey?: string };

export async function loadSettings(path: string): Promise<Settings> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Settings;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

export async function saveSettings(path: string, settings: Settings): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(settings, null, 2), { mode: 0o600 });
	await chmod(path, 0o600); // mode only applies on create
}

/**
 * Merge a browser update into the current settings. An absent or empty `apiKey` keeps the stored one when the
 * provider is unchanged (a key belongs to its provider); `apiKey: null` clears it. Throws on invalid input.
 */
export function applyUpdate(current: Settings, body: unknown): Settings {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("Body must be a JSON object");
	const { provider, model, apiKey } = body as Record<string, unknown>;
	if (!PROVIDERS.includes(provider as Provider)) throw new Error(`provider must be one of ${PROVIDERS.join(", ")}`);
	if (typeof model !== "string" || model.trim() === "") throw new Error("model must be a non-empty string");
	if (apiKey !== undefined && apiKey !== null && typeof apiKey !== "string") throw new Error("apiKey must be a string");
	const next: Settings = { provider: provider as Provider, model: model.trim() };
	const kept = provider === current.provider ? current.apiKey : undefined;
	const key = apiKey === null ? undefined : apiKey?.trim() || kept;
	if (key) next.apiKey = key;
	return next;
}

/** What the browser may see: never the key itself. */
export function redact(settings: Settings, envKeySet: boolean) {
	return {
		provider: settings.provider ?? null,
		model: settings.model ?? null,
		apiKeySet: Boolean(settings.apiKey) || envKeySet,
	};
}
