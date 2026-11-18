import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Channel, Factory } from "../factory.ts";

export type Issue = { id: string; identifier: string; title: string; description?: string | null; url: string };
type Entry = { identifier: string; submissionId?: string; status: "running" | "done" };
type Gql = (query: string, variables: Record<string, unknown>) => Promise<any>;
type Run = Awaited<ReturnType<Factory["run"]>>;

const POLL_MS = 60_000;
const ISSUES = `query($label: String!) { issues(filter: { labels: { name: { eq: $label } }, state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id identifier title description url } } }`;
const COMMENT = `mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;

export function issuePrompt(i: Issue) {
	const branch = `maquila/${i.identifier.toLowerCase()}`;
	return `Linear issue ${i.identifier}: ${i.title}
${i.url}

${i.description || "(no description)"}

Work on it end to end:
1. Start a fresh branch from the latest default branch: \`git fetch origin && git checkout -B ${branch} origin/HEAD\`.
2. Implement the change, following the repo's AGENTS.md / CLAUDE.md and existing conventions. Install any missing toolchain you need.
3. Verify it: run the project's own checks (build, lint, typecheck, tests). Keep the key output.
4. Commit using the repo's commit convention and \`git push -u origin HEAD\`.
5. Open a pull request with \`gh pr create\`. Title includes ${i.identifier}. Body: what changed and why, a link to the Linear issue, and an "Evidence" section with the commands you ran and their trimmed output.
6. Reply with the PR URL and a 2-3 line summary. If you could not finish, say exactly what blocked you.`;
}

function linearGql(apiKey: string): Gql {
	return async (query, variables) => {
		const res = await fetch("https://api.linear.app/graphql", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: apiKey },
			body: JSON.stringify({ query, variables }),
		});
		const body: any = await res.json().catch(() => ({}));
		if (!res.ok || body.errors) throw new Error(`Linear API: ${JSON.stringify(body.errors ?? res.status)}`);
		return body.data;
	};
}

/** Polls Linear for open issues carrying `label` and runs each through the agent, one at a time. */
export async function startLinear(opts: {
	apiKey: string;
	label: string;
	stateFile: string;
	agent: Pick<Factory, "run" | "resume">;
	syncRepo: Factory["syncRepo"];
	gql?: Gql;
	pollMs?: number;
}) {
	const { label, stateFile, agent, syncRepo } = opts;
	const gql = opts.gql ?? linearGql(opts.apiKey);
	let state: Record<string, Entry> = {};
	try {
		state = JSON.parse(await readFile(stateFile, "utf8"));
	} catch {}
	const save = () => writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
	const comment = (issueId: string, body: string) => gql(COMMENT, { issueId, body });

	async function finish(id: string, run: Run) {
		const { ok, text } = await run.done;
		await comment(id, ok ? text || "Maquila finished, but the agent gave no answer." : `Maquila could not finish: ${text}`);
		state[id].status = "done";
		await save();
	}

	async function resumeRunning() {
		for (const [id, e] of Object.entries(state)) {
			if (e.status !== "running") continue;
			try {
				if (e.submissionId) await finish(id, await agent.resume(e.submissionId));
				else {
					await comment(id, "Maquila could not finish: it restarted before the job began.");
					e.status = "done";
					await save();
				}
			} catch (error) {
				console.error(`[linear] resume ${e.identifier} failed:`, error);
			}
		}
	}

	async function poll() {
		const { issues } = await gql(ISSUES, { label });
		for (const issue of issues.nodes as Issue[]) {
			if (state[issue.id]) continue;
			state[issue.id] = { identifier: issue.identifier, status: "running" };
			await save();
			try {
				await comment(issue.id, "Maquila picked this up and is working on it.");
				await syncRepo();
				const run = await agent.run(issuePrompt(issue));
				state[issue.id].submissionId = run.id;
				await save();
				await finish(issue.id, run);
			} catch (error) {
				console.error(`[linear] ${issue.identifier} failed:`, error);
			}
		}
	}

	// A running entry that failed above is picked up by the next start (resume), never re-run.
	let busy = false;
	let resumed = false;
	const tick = async () => {
		if (busy) return;
		busy = true;
		try {
			if (!resumed) {
				resumed = true;
				await resumeRunning();
			}
			await poll();
		} catch (error) {
			console.error("[linear] poll failed:", error);
		}
		busy = false;
	};
	const timer = setInterval(tick, opts.pollMs ?? POLL_MS);
	timer.unref();
	await tick();
	return { tick, stop: () => clearInterval(timer) };
}

/** Channel: enabled by LINEAR_API_KEY; label from MAQUILA_LINEAR_LABEL (default `maquila`). */
const channel: Channel = (factory) => {
	const apiKey = process.env.LINEAR_API_KEY;
	if (!apiKey) return;
	// Not awaited: startLinear resolves only after the first poll, which can run for hours.
	startLinear({
		apiKey,
		label: process.env.MAQUILA_LINEAR_LABEL ?? "maquila",
		stateFile: join(factory.home, "linear.json"),
		agent: factory,
		syncRepo: factory.syncRepo,
	}).catch((error) => console.error("[linear] failed to start:", error));
};
export default channel;
