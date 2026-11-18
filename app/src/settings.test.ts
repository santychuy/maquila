import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyUpdate, loadSettings, redact, saveSettings } from "./settings.ts";

test("settings round-trip with mode 0600 and never expose the key", async () => {
	const path = join(await mkdtemp(join(tmpdir(), "maquila-")), "settings.json");
	assert.deepEqual(await loadSettings(path), {});

	const saved = applyUpdate({}, { provider: "anthropic", model: " claude-x ", apiKey: "sk-secret" });
	await saveSettings(path, saved);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.deepEqual(await loadSettings(path), { provider: "anthropic", model: "claude-x", apiKey: "sk-secret" });

	const view = redact(saved, false);
	assert.deepEqual(view, { provider: "anthropic", model: "claude-x", apiKeySet: true });
	assert.ok(!JSON.stringify(view).includes("sk-secret"));
	assert.equal(redact({}, false).apiKeySet, false);
	assert.equal(redact({}, true).apiKeySet, true);
});

test("applyUpdate keeps, replaces, or clears the key and rejects bad input", () => {
	const current = { provider: "openai" as const, model: "m", apiKey: "old" };
	assert.equal(applyUpdate(current, { provider: "openai", model: "m" }).apiKey, "old");
	assert.equal(applyUpdate(current, { provider: "openai", model: "m", apiKey: "" }).apiKey, "old");
	assert.equal(applyUpdate(current, { provider: "openai", model: "m", apiKey: "new" }).apiKey, "new");
	assert.equal(applyUpdate(current, { provider: "openai", model: "m", apiKey: null }).apiKey, undefined);
	assert.equal(applyUpdate(current, { provider: "anthropic", model: "m" }).apiKey, undefined);
	assert.throws(() => applyUpdate(current, { provider: "nope", model: "m" }));
	assert.throws(() => applyUpdate(current, { provider: "openai", model: "" }));
	assert.throws(() => applyUpdate(current, [1]));
	assert.throws(() => applyUpdate(current, { provider: "openai", model: "m", apiKey: 5 }));
});
