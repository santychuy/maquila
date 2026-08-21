# Local observer

Observer is read-only local view over controller-owned telemetry. It helps an engineer understand a run; it does not launch, retry, cancel, approve, publish, merge, clean up, or mutate workflow state.

Three responsibilities stay separate:

- **Engineer:** owns human authority. Engineer starts work and decides whether to merge or reject proposed changes.
- **Agent roles:** reason, plan, write, and review. Their output is a proposal or report, not an acceptance decision.
- **Code roles:** controller, verifier, and related deterministic code orchestrate work, enforce gates and limits, and record evidence. Model claims do not replace these checks.

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

Ledger never contains prompt bodies, transcripts, assistant text/reasoning, tool arguments/results, stdout/stderr, credentials, SSH destination, identity path, repository files, or artifact content. Negative remote results carry only fixed phase/cause codes; controller converts them to bounded public failure text. Agent phases include archived role metadata, exact model identifier, declared tools, access/thinking settings, SHA-256 system-prompt fingerprint, final reported token totals, and optional provider-reported cost. Reported cost comes from finalized Pi session statistics and is stored as integer nano-USD. It is informational provenance, not independently checked billing, an estimate produced by Factory, acceptance evidence, or proof of actual charges. VM frame validation and harvested evidence checks prove structural consistency, not cryptographic authenticity against a process with VM OS access.

Each agent phase records its authoritative pinned OpenRouter model identifier. Current role defaults are Gemini 3.7 Flash for documenter/reviewer, GLM 5.3 for planner, and Grok 4.6 for worker. Model availability, pricing, and limits remain OpenRouter concerns. Old runs are not backfilled, so metadata, token totals, or reported cost can be absent.

Run detail uses progressive disclosure. Phase buttons first show phase, status, and elapsed time. Selecting one shows core timing and usage plus an **Agent** label when archived agent context exists; controller and other deterministic phases instead show **Code**. Role, model, access, and available-tool count appear only for Agent phases. Exact timestamps, token breakdown, execution limits, and declared tools stay under **Phase metadata**. Repeated tool calls are grouped by tool name and count. Active work takes priority, a prior error remains visible, and a call left open when its phase or run closes appears interrupted. Arguments, results, and per-call detail remain excluded. Raw events remain a collapsed drill-down.

Agent system prompts load only when **System prompt** is opened. Observer reads the role definition from the Factory commit recorded for that run, extracts the prompt body, and returns it only when its SHA-256 hash matches the fingerprint recorded in telemetry. A missing or malformed runtime record, missing commit or role context, or hash mismatch makes retrieval fail. Failure leaves the disclosure available for retry. Prompt bodies are served on demand but are not added to the telemetry ledger. This hash match checks consistency between two run records; it does not establish provenance against a process with Factory checkout or VM OS access.

Open segments grow each poll; completed segments freeze at host finish time. Polling preserves focused and selected segments and drains bounded cursor pages without overlapping ticks. Old runs remain usable when optional fields are absent.

Observer replays same ledger used for live polling. Incomplete trailing line waits for completion. Malformed ledger becomes fixed `invalid` status without raw error disclosure. Browser polls every second and does not overlap requests.

## HTTP API

Bound to loopback only. GET and HEAD only; every other method returns `405`. No CORS. API responses are `no-store`. HTML/assets use CSP, frame denial, no-sniff, and no-referrer headers. Host header must be `127.0.0.1:<port>` or `localhost:<port>`.

```text
GET /api/v1/health
GET /api/v1/runs?limit=100
GET /api/v1/runs/:runId
GET /api/v1/runs/:runId/events?after=0&limit=500
GET /api/v1/runs/:runId/prompts/:actor
GET /
GET /runs/:runId
```

Run summaries include `runtimeMilliseconds` and `phaseRuntimeMilliseconds`, calculated only from host `recordedAt` timestamps. Terminal runs retain total runtime and report no current phase duration. Cursor and limits are bounded. Prompt actor is restricted to `planner`, `worker`, `documenter`, or `reviewer`. There is no ingest, artifact download, archive, or workflow control route.

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
- No remote access or authentication. Loopback reduces network exposure but does not protect prompt bodies from other local processes or users that can reach the observer.
- No raw artifact downloads.
- No credentialed exe.dev smoke proof for observer slice yet.
