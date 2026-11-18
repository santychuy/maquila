import { execFile } from "node:child_process";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openAgent } from "./agent.ts";
import type { Channel, Factory } from "./factory.ts";
import { importAll } from "./load.ts";
import { applySecrets, loadSecretNames } from "./secrets.ts";
import { applyUpdate, loadSettings, redact, saveSettings, type Settings } from "./settings.ts";

const PORT = Number(process.env.PORT ?? 8000);
const HOME = process.env.MAQUILA_HOME ?? join(homedir(), ".maquila");
const REPO = process.env.MAQUILA_REPO;
if (!REPO) {
	console.error("MAQUILA_REPO is required (path to the cloned repository)");
	process.exit(1);
}
const SETTINGS_PATH = join(HOME, "settings.json");
const ENV_PATH = join(HOME, "env");
const INDEX_PATH = new URL("../public/index.html", import.meta.url);
const MAX_BODY = 64 * 1024;

const exec = promisify(execFile);
const git = async (...args: string[]) => (await exec("git", args, { cwd: REPO })).stdout.trim();

/** Keep the clone current before each prompt; never discard local changes. */
async function syncRepo() {
	for (const args of [["fetch", "--all", "--prune"], ["pull", "--ff-only"]]) {
		try {
			await git(...args);
		} catch (error) {
			console.warn(`[sync] git ${args.join(" ")} failed, continuing:`, (error as Error).message.trim());
		}
	}
}

await mkdir(HOME, { recursive: true, mode: 0o700 });
// Lets drop-in files in HOME resolve the packages installed in app/.
await symlink(new URL("../node_modules", import.meta.url).pathname, join(HOME, "node_modules")).catch(() => {});
let settings: Settings = await loadSettings(SETTINGS_PATH);
const agent = await openAgent({ home: HOME, repo: REPO, getSettings: () => settings });

async function keyAvailable() {
	return settings.provider !== undefined && (await agent.models.checkAuth(settings.provider)) !== undefined;
}
async function configured() {
	return Boolean(settings.model) && (await keyAvailable());
}

function send(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY) throw Object.assign(new Error("Body too large"), { status: 413 });
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw Object.assign(new Error("Invalid JSON"), { status: 400 });
	}
}

async function handle(req: IncomingMessage, res: ServerResponse) {
	const route = `${req.method} ${new URL(req.url ?? "/", "http://x").pathname}`;
	switch (route) {
		case "GET /":
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(await readFile(INDEX_PATH));
			return;
		case "GET /api/health":
			return send(res, 200, {
				ok: true,
				repo: REPO,
				branch: await git("rev-parse", "--abbrev-ref", "HEAD").catch(() => null),
				providerConfigured: await configured(),
			});
		case "GET /api/settings":
			return send(res, 200, redact(settings, await keyAvailable()));
		case "POST /api/settings": {
			let next: Settings;
			try {
				next = applyUpdate(settings, await readJson(req));
			} catch (error) {
				return send(res, (error as any).status ?? 400, { error: (error as Error).message });
			}
			await saveSettings(SETTINGS_PATH, next);
			settings = next; // read live by the agent: no restart needed
			return send(res, 200, redact(settings, await keyAvailable()));
		}
		case "GET /api/secrets":
			return send(res, 200, { set: await loadSecretNames(ENV_PATH) });
		case "POST /api/secrets": {
			const body = await readJson(req);
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				return send(res, 400, { error: "Body must be a JSON object" });
			}
			try {
				await applySecrets(ENV_PATH, body as Record<string, string | null>);
			} catch (error) {
				return send(res, (error as any).status ?? 500, { error: (error as Error).message });
			}
			send(res, 200, { set: await loadSecretNames(ENV_PATH), restarting: true });
			// Restart is safe: the durable agent resumes unfinished runs. systemd relaunches with the new env.
			res.on("finish", () => setTimeout(() => process.kill(process.pid, "SIGTERM"), 100));
			return;
		}
		case "POST /api/prompt": {
			const body = (await readJson(req)) as { message?: unknown } | null;
			const message = typeof body?.message === "string" ? body.message.trim() : "";
			if (!message) return send(res, 400, { error: "message must be a non-empty string" });
			if (!(await configured())) {
				return send(res, 409, { error: "No AI provider configured. Open Settings and set a provider, model, and API key." });
			}
			await syncRepo();
			return send(res, 202, { submissionId: await agent.prompt(message) });
		}
		case "GET /api/events": {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			const write = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
			agent.history().forEach(write);
			write({ type: "ready" });
			const unsubscribe = agent.subscribe(write);
			const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
			req.on("close", () => {
				unsubscribe();
				clearInterval(ping);
			});
			return;
		}
		default:
			return send(res, 404, { error: "Not found" });
	}
}

const server = createServer((req, res) => {
	handle(req, res).catch((error) => {
		if (!error.status) console.error(error);
		if (!res.headersSent) send(res, error.status ?? 500, { error: error.status ? error.message : "Internal error" });
		else res.end();
	});
});
const factory: Factory = {
	repo: REPO,
	home: HOME,
	run: agent.run,
	resume: agent.resume,
	syncRepo,
	subscribe: agent.subscribe,
};
// Channels bring work in: built-in ones plus drop-ins from ~/.maquila/channels/.
for (const dir of [new URL("./channels", import.meta.url).pathname, join(HOME, "channels")]) {
	for (const { file, value } of await importAll(dir)) {
		try {
			await (value as Channel)(factory);
		} catch (error) {
			console.error(`[channel ${file}]`, error);
		}
	}
}

server.listen(PORT, () => console.log(`maquila factory on :${PORT} (repo ${REPO}, home ${HOME})`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, async () => {
		server.close();
		server.closeAllConnections();
		await agent.close();
		process.exit(0);
	});
}
