import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applySecrets, loadSecretNames } from "./secrets.ts";

test("secrets round-trip, mode 0600, removal, validation, unrelated lines kept", async () => {
	const path = join(await mkdtemp(join(tmpdir(), "maquila-")), "env");
	assert.deepEqual(await loadSecretNames(path), []);

	await writeFile(path, "# keep me\n\nOTHER=1\n");
	await applySecrets(path, { GH_TOKEN: "abc", LINEAR_API_KEY: "def" });
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.deepEqual(await loadSecretNames(path), ["OTHER", "GH_TOKEN", "LINEAR_API_KEY"]);

	await applySecrets(path, { GH_TOKEN: "xyz", LINEAR_API_KEY: null });
	assert.equal(await readFile(path, "utf8"), "# keep me\nOTHER=1\nGH_TOKEN=xyz\n");
	await applySecrets(path, { GH_TOKEN: "" });
	assert.deepEqual(await loadSecretNames(path), ["OTHER"]);

	for (const updates of [{ "bad name": "x" }, { A: "x\ny" }, { A: 'q"uote' }, { A: " pad" }]) {
		await assert.rejects(applySecrets(path, updates), { status: 400 });
	}
	assert.equal(await readFile(path, "utf8"), "# keep me\nOTHER=1\n");
});
