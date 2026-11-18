# Maquila factory

The service that runs inside the sandbox: one Node process hosting a durable [Pi](https://github.com/earendil-works/pi) coding agent attached to one cloned repository, plus a plain web UI. Runs survive restarts (SQLite-backed `@earendil-works/pi-durable`); unfinished work resumes on boot. Before each prompt it runs `git fetch --all --prune` (failures are only logged), and every job branches from the latest default branch (`origin/HEAD`).

No auth of its own: it is meant to sit behind exe.dev's private HTTPS proxy.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `MAQUILA_REPO` | required | Path to the cloned repository the agent works on |
| `MAQUILA_HOME` | `~/.maquila` | `settings.json` (mode 0600) and `agent.sqlite` |
| `PORT` | `8000` | HTTP port |
| `GH_TOKEN` | — | GitHub token for the agent's `gh` (open PRs) |
| `LINEAR_API_KEY` | — | Enables the Linear channel |

Secrets (`GH_TOKEN`, `LINEAR_API_KEY`, provider keys, any custom name) can be set in the UI under Settings → Secrets; they are written to `$MAQUILA_HOME/env` (mode 0600) and the service restarts.
| `MAQUILA_LINEAR_LABEL` | `maquila` | Label that marks Linear issues as jobs |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | — | Used when Settings has no key for the chosen provider |

The AI provider is optional at boot. Pick provider, model, and key in the UI's Settings; changes apply without a restart. The key is never sent back to the browser.

## Linear channel

With `LINEAR_API_KEY` set, the factory polls Linear every 60s for open issues labelled `maquila` and handles them one at a time: it comments that it picked the issue up, has the agent branch, implement, verify, push and open a PR (needs `GH_TOKEN`), then comments the result. Handled issues are tracked in `~/.maquila/linear.json`; a run interrupted by a restart is resumed and its result still posted. Jobs share the UI's conversation, so they show up live there.

Maquila does not change issue status itself. Enable Linear's GitHub integration (Linear → Settings → Integrations → GitHub): branch names already include the issue id (`maquila/riff-67`), so the PR attaches to the issue, moving it to In Progress when opened and Done when merged.

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
- `GET /api/jobs` job history, newest first: `{ id, source, title, url?, status, startedAt, endedAt?, result?, prUrl? }` (last 200)
- `GET /api/jobs/:id` `{ job, events }` the job and its transcript (same events as `/api/events`, no `delta`)
- `GET|POST /api/settings` `{ provider, model, apiKey? }` (GET returns `apiKeySet`, never the key)
- `GET|POST /api/secrets` `{ NAME: "value" | null }` set/remove env secrets, then restart (GET returns names only)
- `GET /api/health` repo path, branch, whether a provider is configured
