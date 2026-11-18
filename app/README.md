# Maquila factory

The service that runs inside the sandbox: one Node process hosting a durable [Pi](https://github.com/earendil-works/pi) coding agent attached to one cloned repository, plus a plain web UI. Runs survive restarts (SQLite-backed `@earendil-works/pi-durable`); unfinished work resumes on boot. Before each prompt it runs `git fetch --all --prune` and `git pull --ff-only`, and only logs failures (local changes are never discarded).

No auth of its own: it is meant to sit behind exe.dev's private HTTPS proxy.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `MAQUILA_REPO` | required | Path to the cloned repository the agent works on |
| `MAQUILA_HOME` | `~/.maquila` | `settings.json` (mode 0600) and `agent.sqlite` |
| `PORT` | `8000` | HTTP port |
| `GH_TOKEN` | — | GitHub token for the agent's `gh` (open PRs) |
| `LINEAR_API_KEY` | — | Enables the Linear channel |
| `MAQUILA_LINEAR_LABEL` | `maquila` | Label that marks Linear issues as jobs |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | — | Used when Settings has no key for the chosen provider |

The AI provider is optional at boot. Pick provider, model, and key in the UI's Settings; changes apply without a restart. The key is never sent back to the browser.

## Linear channel

With `LINEAR_API_KEY` set, the factory polls Linear every 60s for open issues labelled `maquila` and handles them one at a time: it comments that it picked the issue up, has the agent branch, implement, verify, push and open a PR (needs `GH_TOKEN`), then comments the result. Handled issues are tracked in `~/.maquila/linear.json`; a run interrupted by a restart is resumed and its result still posted. Jobs share the UI's conversation, so they show up live there.

## Run locally

Node 22.19+ (TypeScript runs directly through Node's type stripping, no build).

```bash
npm install
MAQUILA_REPO=/path/to/repo npm start   # http://localhost:8000
npm test
```

## HTTP API

- `GET /` UI
- `POST /api/prompt` `{ "message": "..." }` queue a prompt (409 when no provider is configured)
- `GET /api/events` Server-Sent Events: recent history, then `delta`, `assistant`, `tool`, `tool_result`, `error`, `end`
- `GET|POST /api/settings` `{ provider, model, apiKey? }` (GET returns `apiKeySet`, never the key)
- `GET /api/health` repo path, branch, whether a provider is configured
