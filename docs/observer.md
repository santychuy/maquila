# Local observer

Observer is read-only local view over controller-owned telemetry. It does not launch, retry, cancel, approve, publish, merge, clean up, or mutate workflow state.

## Daily workflow

```bash
pnpm run build
pnpm run factory -- observer ensure --json
pnpm run factory -- run start \
  --target /absolute/path/to/target-repository \
  --issue RIFF-52 \
  --json
```

`run start` returns accepted run ID before workflow completion. Open `<observer-url>/runs/<run-id>`. Pi users operating from trusted factory checkout may use `/skill:software-factory` with same issue ID and explicit target path.

Foreground server behaves like development server:

```bash
pnpm run factory -- observer serve --port 4600
```

`observer ensure --json` starts or reuses detached instance. `observer status --json` checks descriptor-bound health. `observer stop --json` signals only process whose instance, PID, health response, and stable process identity match private descriptor. Default is fixed `127.0.0.1:4600`; override with `--port` or `FACTORY_OBSERVER_PORT`. No automatic alternate port or OS boot service exists.

## Data contract

Controller is sole writer of `.factory/telemetry/<run-id>.jsonl`. Each strict event has host-assigned gap-free sequence. Ledger contains phase boundaries, safe agent/tool names, deterministic gate summary, reviewer verdict/count, failure, cleanup, heartbeat, terminal result, and safe artifact metadata. Remote commands are capped at 20,000 frames and 8 MiB; each host ledger is capped at 32 MiB before append or replay. Exceeding a cap fails the run and still attempts cleanup.

It never contains prompts, transcripts, assistant text/reasoning, tool arguments/results, stdout/stderr, credentials, SSH destination, identity path, repository files, or artifact content. VM frame validation and harvested evidence checks prove structural consistency, not cryptographic authenticity against process with VM OS access.

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

## Limits

- One serial local controller; no fleet aggregation.
- JSONL replay, not SQLite analytics or retention controls.
- Runs created before canonical telemetry can be queried by known UUID as `legacy`, but are omitted from the run list.
- Polling, not WebSocket or SSE.
- No remote access/authentication.
- No raw artifact downloads.
- No credentialed exe.dev smoke proof for observer slice yet.
