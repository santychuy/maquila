import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { AssistantEntry, createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { openJobs, type JobMeta } from "./jobs.ts";
import { importAll } from "./load.ts";
import type { Settings } from "./settings.ts";

export type AgentOutcome = { ok: boolean; text: string };
export type AgentEvent = Record<string, unknown> & { type: string };

/** Opens the durable agent. `getSettings` is read live, so settings changes need no restart. */
export async function openAgent(opts: { home: string; repo: string; getSettings: () => Settings }) {
	const { home, repo, getSettings } = opts;

	// The key comes from settings.json; when absent, providers fall back to their env vars (ANTHROPIC_API_KEY, ...).
	const models = createModels({
		credentials: {
			read: async (id) => {
				const s = getSettings();
				return s.provider === id && s.apiKey ? { type: "api_key", key: s.apiKey } : undefined;
			},
			list: async () => {
				const s = getSettings();
				return s.provider && s.apiKey ? [{ providerId: s.provider, type: "api_key" }] : [];
			},
			modify: async (_id, fn) => fn(undefined), // keys are only written through our Settings
			delete: async () => {},
		},
	});
	for (const p of [anthropicProvider(), openaiProvider(), openrouterProvider()]) models.setProvider(p);

	const registry = createRegistry();
	registry.install(createCodingTools());
	registry.install(
		defineExtension({
			name: "maquila",
			sections: [
				section(
					"preamble",
					() =>
						`You are Maquila, a coding agent that works 24/7 on the git repository at ${repo}. ` +
						"Work on branches, commit your changes, and never discard uncommitted work you did not make.",
					{ tag: false },
				),
			],
		}),
	);

	// User extensions: default exports (defineExtension results) from ~/.maquila/extensions/.
	for (const { file, value } of await importAll(`${home}/extensions`)) {
		try {
			registry.install(value as any);
		} catch (error) {
			console.error(`[extension ${file}]`, error);
		}
	}

	const storage = await openNodeSqliteStorage(`${home}/agent.sqlite`);
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			env: () => new NodeExecutionEnv({ cwd: repo }),
			onReport: (r) => console.error(`[agent] ${r.kind}:`, r.error),
		},
		ctx,
	);
	const root = await harness.root(ctx);
	harness.resume(); // continue any run the last process left unfinished

	// Turn view changes into a flat event stream for the UI.
	const listeners = new Set<(e: AgentEvent) => void>();
	const jobs = await openJobs(home);
	const emit = (e: AgentEvent) => {
		listeners.forEach((l) => l(e));
		if (e.type !== "delta") jobs.append(e);
	};
	const seen = new Set<string>();
	let streamed = "";
	let busy = false;
	const watch = await root.watch(ctx);
	let view = watch.value;
	for (const e of view.entries) seen.add(String(e.id));
	busy = view.docs["pi.live"]?.run !== undefined;
	watch.start(async (call) => {
		if (call.kind !== "value") return;
		view = call.value;
		const live = view.docs["pi.live"] as any;
		const partial = textOf(live?.generation?.message);
		if (partial.startsWith(streamed) && partial.length > streamed.length) {
			emit({ type: "delta", text: partial.slice(streamed.length) });
			streamed = partial;
		}
		for (const entry of view.entries) {
			if (seen.has(String(entry.id))) continue;
			seen.add(String(entry.id));
			if (entry.kind === "pi.assistant") streamed = "";
			entryEvents(entry).forEach(emit);
		}
		const nowBusy = live?.run !== undefined;
		if (busy && !nowBusy) emit({ type: "end", failure: live?.runFailure ?? null });
		busy = nowBusy;
	});

	async function outcome(submission: { wait: (c: typeof ctx) => Promise<any> }): Promise<AgentOutcome> {
		const settled = await submission.wait(ctx);
		let result: AgentOutcome;
		if (settled.status !== "done") result = { ok: false, text: String(settled.detail ?? settled.reason ?? "unanswered") };
		else {
			const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
			result = { ok: true, text: textOf(entry?.model?.[0]) };
		}
		await jobs.finish(String(submission.id), result);
		return result;
	}

	// Jobs left running by the last process: fail the lost ones, track the rest to completion.
	await jobs.failMissing(async (id) => Boolean(await harness.submission(id as any, ctx)));
	for (const j of jobs.running()) harness.submission(j.id as any, ctx).then((s) => s && outcome(s)).catch(() => {});

	/** Submit and let the caller await the outcome. */
	// shortcut: Linear jobs share the UI's single root conversation (so they show live in the UI), so they interleave with UI prompts; split into per-job conversations if that hurts.
	async function run(message: string, job?: JobMeta) {
		const { provider, model } = getSettings();
		if (provider && model) await root.configure({ model: { provider, modelId: model } }, ctx);
		const submission = await root.submit({ type: "input", content: message }, ctx);
		await jobs.start(String(submission.id), { source: "web", ...job }, message);
		return { id: String(submission.id), done: outcome(submission) };
	}

	return {
		jobs,
		harness,
		models,
		/** Recent transcript as events, for a client that just connected. */
		history: () => view.entries.flatMap(entryEvents),
		subscribe(listener: (e: AgentEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		run,
		async prompt(message: string, job?: JobMeta) {
			return (await run(message, job)).id;
		},
		/** Re-attach to a submission after a restart. */
		async resume(id: string) {
			const submission = await harness.submission(id as any, ctx);
			if (!submission) return { id, done: Promise.resolve({ ok: false, text: "submission not found" }) };
			return { id, done: outcome(submission) };
		},
		async close() {
			await watch.stop();
			await harness.close(ctx);
		},
	};
}

function textOf(message: any): string {
	return (message?.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("");
}

function entryEvents(entry: { kind: string; model?: readonly any[] }): AgentEvent[] {
	const msg = entry.model?.[0];
	if (!msg) return [];
	if (entry.kind === "pi.user") {
		const text = typeof msg.content === "string" ? msg.content : textOf(msg);
		return [{ type: "user", text }];
	}
	if (entry.kind === "pi.assistant") {
		const events: AgentEvent[] = [];
		const text = textOf(msg);
		if (text) events.push({ type: "assistant", text });
		for (const c of msg.content ?? []) if (c.type === "toolCall") events.push({ type: "tool", name: c.name, args: c.arguments });
		if (msg.stopReason === "error" || msg.stopReason === "aborted") events.push({ type: "error", text: msg.errorMessage ?? msg.stopReason });
		return events;
	}
	if (entry.kind === "pi.tool-result") {
		return [{ type: "tool_result", name: msg.toolName, isError: Boolean(msg.isError), text: textOf(msg).slice(0, 2000) }];
	}
	return [];
}
