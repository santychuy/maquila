// The public contract for extending Maquila. Types only.
import type { AgentEvent, AgentOutcome } from "./agent.ts";

/** One agent submission: its durable id and a promise for the final answer. */
export type Run = { id: string; done: Promise<AgentOutcome> };

/** What a channel can use. */
export type Factory = {
	/** Path to the cloned repository. */
	repo: string;
	/** State directory (`~/.maquila`). */
	home: string;
	/** True when an AI provider, model and key are set; channels must not take work before. */
	ready(): Promise<boolean>;
	/** Submit work to the agent. `job` labels it in job history (source defaults to "web"); non-web jobs run in their own conversation. */
	run(message: string, job?: { source?: string; title?: string; url?: string }): Promise<Run>;
	/** Re-attach to a submission by id after a restart. */
	resume(id: string): Promise<Run>;
	/** Fetch/pull the clone; call before `run`. */
	syncRepo(): Promise<void>;
	/** Stream agent events (same as the web UI). Returns an unsubscribe function. */
	subscribe(listener: (e: AgentEvent) => void): () => void;
};

/** A channel brings work in. Default export of a file in `src/channels/` or `~/.maquila/channels/`.
 *  It reads its own config from process.env and returns early when unconfigured. */
export type Channel = (factory: Factory) => unknown | Promise<unknown>;

// Agent extensions need no type here: default-export the result of pi-durable's `defineExtension(...)`
// from a file in `~/.maquila/extensions/`.
