import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openJobs, validJobId } from "./jobs.ts";

const tmp = () => mkdtemp(join(tmpdir(), "jobs-"));

test("job lifecycle: events in order, done with PR url", async () => {
	const home = await tmp();
	const jobs = await openJobs(home);
	await jobs.start("1", { source: "linear", title: "ENG-1: x", url: "http://l/1" });
	await jobs.append({ type: "user", text: "hi" });
	await jobs.append({ type: "assistant", text: "ok" });
	await jobs.finish("1", { ok: true, text: "PR: https://github.com/a/b/pull/12 done" });
	const [job] = (await openJobs(home)).list(); // reloaded from disk
	assert.equal(job.status, "done");
	assert.equal(job.prUrl, "https://github.com/a/b/pull/12");
	assert.ok(job.endedAt);
	assert.equal(job.source, "linear");
	assert.deepEqual((await jobs.events("1"))?.map((e) => e.type), ["user", "assistant"]);
	assert.equal(await jobs.events("2"), undefined);
});

test("events go to the oldest running job; failed jobs keep the reason", async () => {
	const jobs = await openJobs(await tmp());
	await jobs.start("1", {}, "first");
	await jobs.start("2", {}, "second");
	await jobs.append({ type: "user", text: "a" });
	await jobs.finish("1", { ok: false, text: "boom" });
	await jobs.append({ type: "user", text: "b" });
	assert.equal((await jobs.events("1"))?.length, 1);
	assert.equal((await jobs.events("2"))?.length, 1);
	assert.equal(jobs.list().find((j) => j.id === "1")?.status, "failed");
});

test("index is capped at 200, newest first", async () => {
	const jobs = await openJobs(await tmp());
	for (let i = 1; i <= 205; i++) await jobs.start(String(i), {}, "t");
	assert.equal(jobs.list().length, 200);
	assert.equal(jobs.list()[0].id, "205");
});

test("ids are validated", async () => {
	assert.equal(validJobId("../x"), false);
	assert.equal(validJobId("12"), true);
	assert.equal(await (await openJobs(await tmp())).events("../x"), undefined);
});

test("a channel job's events land only in its own transcript", async () => {
	const jobs = await openJobs(await tmp());
	await jobs.start("1", { source: "linear", conversationId: "c1" }, "a");
	await jobs.start("2", { source: "linear", conversationId: "c2" }, "b");
	await jobs.append({ type: "user", text: "for 2" }, "2");
	await jobs.append({ type: "user", text: "for 1" }, "1");
	await jobs.append({ type: "user", text: "web" }); // root events never go to channel jobs
	assert.equal((await jobs.events("1"))?.length, 1);
	assert.equal((await jobs.events("2"))?.length, 1);
	assert.equal(jobs.list().find((j) => j.id === "2")?.conversationId, "c2");
});
