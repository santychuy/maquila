import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

export type JobMeta = { source?: string; title?: string; url?: string; conversationId?: string };
export type Job = {
	id: string;
	source: string;
	title: string;
	url?: string;
	/** Set for jobs that run in their own conversation (not the shared root). */
	conversationId?: string;
	status: "running" | "done" | "failed";
	startedAt: string;
	endedAt?: string;
	result?: string;
	prUrl?: string;
};

const MAX_JOBS = 200;
const PR_URL = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
// Submission ids are numeric.
export const validJobId = (id: string) => /^\d{1,20}$/.test(id);

/** Job history under `<home>/jobs/`: `index.json` (newest first) plus one `<id>.jsonl` transcript per job. */
export async function openJobs(home: string) {
	const dir = join(home, "jobs");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const indexPath = join(dir, "index.json");
	let jobs: Job[] = [];
	try {
		jobs = JSON.parse(await readFile(indexPath, "utf8"));
	} catch {}
	// Serialize writes so concurrent events keep order.
	let chain: Promise<unknown> = Promise.resolve();
	const queue = (fn: () => Promise<unknown>) => (chain = chain.then(fn).catch((e) => console.error("[jobs]", e)));
	const save = () => queue(() => writeFile(indexPath, JSON.stringify(jobs, null, 2), { mode: 0o600 }));

	return {
		list: () => jobs,
		running: () => jobs.filter((j) => j.status === "running"),
		start(id: string, meta: JobMeta = {}, message = "") {
			if (jobs.some((j) => j.id === id)) return;
			const job: Job = { id, source: meta.source ?? "web", title: meta.title ?? message.slice(0, 80), startedAt: new Date().toISOString(), status: "running" };
			if (meta.url) job.url = meta.url;
			if (meta.conversationId) job.conversationId = meta.conversationId;
			jobs = [job, ...jobs].slice(0, MAX_JOBS);
			return save();
		},
		/** Events of a job's own conversation go to `jobId`; root-conversation events (web) go to the oldest running web job. */
		append(event: Record<string, unknown>, jobId?: string) {
			const job = jobId ? jobs.find((j) => j.id === jobId) : jobs.findLast((j) => j.status === "running" && !j.conversationId);
			if (!job) return;
			return queue(() => appendFile(join(dir, `${job.id}.jsonl`), JSON.stringify(event) + "\n", { mode: 0o600 }));
		},
		finish(id: string, outcome: { ok: boolean; text: string }) {
			const job = jobs.find((j) => j.id === id);
			if (!job || job.status !== "running") return;
			job.status = outcome.ok ? "done" : "failed";
			job.endedAt = new Date().toISOString();
			job.result = outcome.text;
			const pr = outcome.text.match(PR_URL)?.[0];
			if (pr) job.prUrl = pr;
			return save();
		},
		async events(id: string): Promise<Record<string, unknown>[] | undefined> {
			if (!validJobId(id) || !jobs.some((j) => j.id === id)) return undefined;
			const text = await readFile(join(dir, `${id}.jsonl`), "utf8").catch(() => "");
			return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
		},
		/** Jobs whose submission no longer exists will never finish. */
		failMissing(exists: (id: string) => Promise<boolean>) {
			return Promise.all(this.running().map(async (j) => ((await exists(j.id)) ? undefined : this.finish(j.id, { ok: false, text: "submission not found" }))));
		},
	};
}
