# Local observer

Observer is read-only local view over controller-owned telemetry. It does not launch, retry, cancel, approve, publish, merge, clean up, or mutate workflow state.

## Daily workflow

Build and link global executable once, then configure host tools:

```bash
bun run build
bun link
factory setup
factory doctor
```

Run commands use current working directory as target. Use `--target` for another repository; `--json` selects machine output.

Human workflow:

```bash
factory dashboard
factory run start --issue RIFF-52
```

`factory dashboard` starts the detached local dashboard when absent or reuses its healthy process, then prints its URL. Scripts and the Pi skill use the machine-compatible form:

```bash
factory observer ensure --json
factory run start --issue RIFF-52 --json
factory run start --target /absolute/path/to/target-repository --issue RIFF-52 --json
```

`run start` returns accepted run ID before workflow completion. Open `<observer-url>/runs/<run-id>`. Pi users may use `/skill:software-factory` from target repository with only issue ID.

Foreground server behaves like development server:

```bash
factory observer serve --port 4600
```

`dashboard` and `observer ensure --json` start or reuse the same detached instance. `observer status --json` checks descriptor-bound health. `observer stop --json` signals only process whose instance, PID, health response, and stable process identity match private descriptor. Default is fixed `127.0.0.1:4600`; override with `--port` or `FACTORY_OBSERVER_PORT`. No automatic alternate port or OS boot service exists.

## Data contract

Controller is sole writer of `.factory/telemetry/<run-id>.jsonl`. Each strict event has host-assigned gap-free sequence. Ledger contains phase boundaries, safe agent/tool names, deterministic gate summary, reviewer verdict/count, failure, cleanup, heartbeat, terminal result, and safe artifact metadata. Remote commands are capped at 20,000 frames and 8 MiB; each host ledger is capped at 32 MiB before append or replay. Exceeding a cap fails the run and still attempts cleanup.

It never contains prompt bodies, transcripts, assistant text/reasoning, tool arguments/results, stdout/stderr, credentials, SSH destination, identity path, repository files, artifact content, or billed/actual cost. Agent phases include immutable archived role metadata, exact model identifier, declared tools, access/thinking settings, SHA-256 system-prompt fingerprint, and final reported token totals only. Prompt bodies remain unavailable by design. Token counts are informational VM instrumentation, not acceptance evidence. VM frame validation and harvested evidence checks prove structural consistency, not cryptographic authenticity against process with VM OS access.

Each agent phase records its authoritative pinned OpenRouter model identifier, role metadata, and reported token totals. Current role defaults are `openrouter/openai/gpt-5.6-terra`. Runtime does not provide a complete model catalog or billing estimate; model availability, pricing, and limits remain OpenRouter concerns. Old runs are not backfilled. Token counts are informational, not acceptance or billing evidence.

Run detail presents horizontally scrollable actor/phase buttons from host `recordedAt` phase boundaries. Open segments grow each poll; completed segments freeze at host finish time. Keyboard or pointer selection shows actor, status, timing, safe role/model metadata, tools, reported tokens, and prompt fingerprint. Raw events remain a collapsed drill-down. Polling preserves focused and selected segments and drains bounded cursor pages without overlapping ticks. Old runs remain usable with unavailable metadata fields.

Observer replays same ledger used for live polling. Incomplete trailing line waits for completion. Malformed ledger becomes fixed `invalid` status without raw error disclosure. Browser polls every second and does not overlap requests.

## HTTP API

Bound to loopback only. GET and HEAD only; every other method returns `405`. No CORS. API responses are `no-store`. HTML/assets use CSP, frame denial, no-sniff, and no-referrer headers. Host header must be `127.0.0.1:<port>` or `localhost:<port>`.

```text
GET /api/v1/health
GET /api/v1/runs?limit=100
GET /api/v1/runs/:runId
GET /api/v1/runs/:runId/events?after=0&limit=500
GET /
GET /runs/:runId
```

Run summaries include `runtimeMilliseconds` and `phaseRuntimeMilliseconds`, calculated only from host `recordedAt` timestamps. Terminal runs retain total runtime and report no current phase duration. Cursor and limits are bounded. There is no ingest, artifact download, archive, or workflow control route.

## Process ownership

`.factory/observer.json` is atomic mode `0600`; containing directory and logs are private. Descriptor records version, random instance ID, PID, stable Linux process-birth identity when available, port, URL, and start time. `ensure` reuses only matching health response. Live unhealthy owner, invalid descriptor, occupied port, and PID ambiguity fail safely without killing process.

## Failure semantics

Observer or browser outage never changes controller result. If canonical telemetry cannot be written, controller fails run safely and still attempts VM cleanup. Stale heartbeat displays `activity unknown`, not success or failure. Success appears only after validated evidence and completed cleanup.

## Host credentials

`factory setup` stores strict XDG config at `$XDG_CONFIG_HOME/factory/config.json` or `~/.config/factory/config.json`. It stores only optional Linear and OpenRouter `op://Vault/Item/field` references; `--install-skill` optionally links the Factory Pi skill into the user scope. `factory doctor` checks config, target, GitHub, Linear, and OpenRouter credentials, SSH, built CLI, and skill, then prints remediation.

GitHub precedence is `GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token`. Linear precedence is `LINEAR_API_TOKEN`, then `op read` of configured reference. OpenRouter precedence is `OPENROUTER_API_KEY`, then `op read` of configured reference. exe.dev identity is optional through `--identity` or `FACTORY_EXE_IDENTITY`; OpenSSH config and agent work without it. `SSH_AUTH_SOCK` stays on host, and SSH uses `ForwardAgent=no`. Linear and GitHub credentials remain controller-side. OpenRouter uses a dedicated capped key as deliberate transient VM exception; controller writes it to VM-local Pi config for agent calls, best-effort removes it before VM destruction, and tells user to revoke key if cleanup fails. VM is not a security sandbox. Runtime state remains under Factory checkout. No Linear OAuth, native keychain, or profiles exist.

## Limits

- One serial local controller; no fleet aggregation.
- JSONL replay, not SQLite analytics or retention controls. See [SQLite storage research](sqlite-storage-research.md) for evidence and future migration candidates.
- Runs created before canonical telemetry can be queried by known UUID as `legacy`, but are omitted from the run list.
- Polling, not WebSocket or SSE.
- No remote access/authentication.
- No raw artifact downloads.
- No credentialed exe.dev smoke proof for observer slice yet.
