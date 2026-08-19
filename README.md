# Software Factory

Small local software factory that runs bounded planner, worker, verification, and independent-review sessions inside a fresh exe.dev VM. Controller keeps Linear/GitHub authority on host, harvests evidence and patch, destroys VM, then stops at `ready_for_publication`. Human owns merge or rejection.

## Install

Requires Node.js `>=22.19.0` and pnpm `11.22.0`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm check
```

Set controller credentials without printing them:

```bash
export LINEAR_API_TOKEN=...
export GITHUB_TOKEN=...
export FACTORY_EXE_IDENTITY=/absolute/path/to/exe-dev-key
```

## Daily observed run

Start or reuse read-only local observer:

```bash
pnpm run factory -- observer ensure --json
```

Start run against explicit target Git repository and return immediately:

```bash
pnpm run factory -- run start \
  --target /absolute/path/to/target-repository \
  --issue RIFF-52 \
  --json
```

Use `observer.url` from `observer ensure --json` and `runId` from `run start --json` to open `<observer.url>/runs/<runId>` (normally `http://127.0.0.1:4600/runs/<run-id>`). Dashboard polls canonical host telemetry and shows live phase, safe tool activity, deterministic gates, reviewer result, cleanup, failures, and safe artifact metadata. It has no workflow controls.

Check without browser:

```bash
pnpm run factory -- run status --run-id <run-id> --json
pnpm run factory -- observer status --json
```

Run observer in foreground, like a development server:

```bash
pnpm run factory -- observer serve --port 4600
```

Stop only the descriptor- and health-verified observer process:

```bash
pnpm run factory -- observer stop --json
```

Pi users in this trusted repository can invoke `/skill:software-factory`. Skill requires Linear issue ID and absolute target-repository path, then routes through deterministic commands above.

## Evidence

- `.factory/telemetry/<run-id>.jsonl` — canonical safe live event ledger
- `.factory/controllers/<run-id>/` — host controller state, patch, and harvested evidence
- `.factory/runs/<run-id>/` — local/remote role receipts and transcripts
- `.factory/observer.json` — private observer ownership descriptor

All generated `.factory/` content is ignored by Git. Observer binds only `127.0.0.1`, accepts GET/HEAD only, serves no artifact content, and never exposes prompts, transcripts, reasoning, tool arguments/results, stdout/stderr, credentials, or repository files.

See [docs/observer.md](docs/observer.md), [ARCHITECTURE.md](ARCHITECTURE.md), [docs/envelopes.md](docs/envelopes.md), and [docs/foundation-checkpoint.md](docs/foundation-checkpoint.md).

## Limits

GitHub PR publication, fix pass, in-flight resume, automatic merge, deployment, and guaranteed cleanup while exe.dev deletion is unavailable remain absent. No credentialed live observer run has been recorded for this new slice yet; local fake lifecycle and deterministic tests are required before that smoke proof.
