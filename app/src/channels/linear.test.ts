import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { issuePrompt, startLinear } from "./linear.ts";

const issue = { id: "i1", identifier: "ENG-7", title: "Fix it", description: null, url: "http://l/ENG-7" };

async function setup(initial?: object, opts: { ready?: boolean; issue?: object } = {}) {
	const stateFile = join(await mkdtemp(join(tmpdir(), "linear-")), "linear.json");
	if (initial) await writeFile(stateFile, JSON.stringify(initial));
	const comments: string[] = [];
	const prompts: string[] = [];
	const resumed: string[] = [];
	const gql = async (query: string, vars: any) => {
		if (query.includes("commentCreate")) return void comments.push(vars.body);
		polls.push(query);
		return { issues: { nodes: [{ ...issue, ...opts.issue }] } };
	};
	const polls: string[] = [];
	const agent = {
		ready: async () => opts.ready ?? true,
		run: async (m: string) => (prompts.push(m), { id: "s1", done: Promise.resolve({ ok: true, text: "PR: http://pr" }) }),
		resume: async (id: string) => (resumed.push(id), { id, done: Promise.resolve({ ok: true, text: "resumed answer" }) }),
	};
	const linear = await startLinear({ apiKey: "k", label: "maquila", stateFile, agent, syncRepo: async () => {}, gql, pollMs: 1e9 });
	return { linear, comments, prompts, resumed, stateFile, polls };
}

test("new issue is picked up once, commented, and recorded", async () => {
	const t = await setup();
	await t.linear.tick();
	await t.linear.tick(); // second poll must not re-run it
	t.linear.stop();
	assert.equal(t.prompts.length, 1);
	assert.match(t.prompts[0], /ENG-7/);
	assert.match(t.prompts[0], /\(no description\)/);
	assert.deepEqual(t.comments, ["Maquila picked this up and is working on it.", "PR: http://pr"]);
	assert.equal(JSON.parse(await readFile(t.stateFile, "utf8")).i1.status, "done");
});

test("running entry with a submission id is resumed on start", async () => {
	const t = await setup({ i1: { identifier: "ENG-7", submissionId: "s0", status: "running" } });
	t.linear.stop();
	assert.deepEqual(t.resumed, ["s0"]);
	assert.deepEqual(t.comments, ["resumed answer"]);
	assert.equal(t.prompts.length, 0);
	assert.match(issuePrompt(issue), /maquila\/eng-7/);
});

test("issue already commented as picked up by another factory is skipped", async () => {
	const t = await setup(undefined, { issue: { comments: { nodes: [{ body: "Maquila picked this up and is working on it." }] } } });
	t.linear.stop();
	assert.equal(t.prompts.length, 0);
	assert.deepEqual(t.comments, []);
});

test("nothing is polled or commented while the factory is not ready", async () => {
	const t = await setup(undefined, { ready: false });
	await t.linear.tick();
	t.linear.stop();
	assert.equal(t.polls.length, 0);
	assert.equal(t.prompts.length, 0);
	assert.deepEqual(t.comments, []);
});
