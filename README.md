# Maquila

**A software factory for your codebase in one command.**

Maquila deploys a durable coding agent into an always-on cloud sandbox, attached to your GitHub repository. Your code lives there, stays in sync with your team, and the agent is ready for work 24/7.

```bash
npx skills add santychuy/maquila --skill maquila
```

Then, from inside your repository, ask your agent (Claude Code, Codex, Cursor, …):

> Set up Maquila for this repo.

The agent takes it from there. It asks which sandbox to use and, optionally, your AI provider. Then it provisions the sandbox, clones your repo, starts the factory, and gives you the URL. Setup will ask you to run one masked prompt in your own terminal for your keys, so they never pass through the chat.

## What you get

| | |
|---|---|
| **Durable agent** | A [Pi](https://github.com/earendil-works/pi) coding agent whose runs survive restarts and resume where they stopped. |
| **Channels** | A web UI and Linear issues (polled) to give it work. Webhooks, GitHub events, Slack, and schedules come later. |
| **Sandbox** | An [exe.dev](https://exe.dev) VM running 24/7 with your repo cloned, private to you behind exe.dev login. |

One factory is attached to one repository.

## Requirements

- A GitHub repository you admin, with [`gh`](https://cli.github.com) authenticated locally
- `git` and `ssh`
- An [exe.dev](https://exe.dev) account (the setup walks you through signup)
- Optionally, an API key for Anthropic, OpenAI, or OpenRouter (entered in that masked prompt, or later in Settings)

## How it works

```
your machine                          exe.dev VM (https://<repo>-maquila.exe.xyz)
┌──────────────────────┐   ssh        ┌──────────────────────────────────────┐
│ your agent + skill   │ ───────────▶ │ maquila service (systemd, :8000)     │
│  • preflight         │              │  ├─ web UI + settings                │
│  • create VM         │              │  └─ durable Pi agent ──▶ ~/<repo>    │
│  • add deploy key    │              │       (git fetch before each job,     │
│  • run bootstrap.sh  │              │        pushes work to branches)      │
└──────────────────────┘              └──────────────────────────────────────┘
```

See [docs/design.md](docs/design.md) for the design and its decisions.

## Repository layout

```
skills/maquila/   The published skill: the entry point
app/              The factory service that runs in the sandbox
docs/             Design notes
```

## Extending Maquila

Two primitives, both plain files you drop in and load on restart (`sudo systemctl restart maquila`). Custom files may import only node builtins and the packages already in `app/` (no install step yet). The contract is in `app/src/factory.ts`.

**Channels** bring work in. Put a `.ts`/`.js` file in `~/.maquila/channels/` whose default export is a `Channel`: it gets the `factory` (`run`, `resume`, `syncRepo`, `subscribe`, `repo`, `home`), reads its own config from `process.env`, and returns early when unconfigured. A channel that throws is logged and skipped. Linear (`app/src/channels/linear.ts`) is built this way. A channel's `run(message, { source, title, url })` shows up in job history. Custom channels and extensions read their config from env; set it in the factory under Settings → Secrets.

```ts
// ~/.maquila/channels/nightly.ts: run a prompt every 24h
import type { Channel } from "/home/<user>/maquila/app/src/factory.ts"; // type-only, erased at runtime
const nightly: Channel = (factory) => {
	setInterval(async () => {
		await factory.syncRepo();
		console.log((await (await factory.run("Triage open TODOs and report.")).done).text);
	}, 24 * 3600_000);
};
export default nightly;
```

**Agent extensions** shape the agent. Put a file in `~/.maquila/extensions/` whose default export is a pi-durable `defineExtension(...)`:

```ts
// ~/.maquila/extensions/style.ts
import { defineExtension, section } from "@earendil-works/pi-durable";
export default defineExtension({
	name: "style",
	sections: [section("style", () => "Prefer small PRs and always add tests.", { tag: false })],
});
```

## Philosophy

Maquila ships the core and nothing else. Bring your own tools, integrations, channels, and workflows. Fork it, extend it, and make it fit how your team works.

## Contributing

Issues and PRs are welcome. Read [AGENTS.md](AGENTS.md) first.

## License

[MIT](LICENSE)
