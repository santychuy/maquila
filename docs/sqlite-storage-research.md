# SQLite storage research and migration candidates

Research snapshot: 2026-08-20. This document records evidence and possible future implementation slices. It is not an approved migration plan and does not describe implemented behavior.

See [observer](observer.md), [foundation checkpoint](foundation-checkpoint.md), and [architecture](../ARCHITECTURE.md).

## Agent handoff

Load this section first.

- Maquila does not save everything in JSONL. Runtime storage is a mix of JSONL ledgers and transcripts, atomic JSON state snapshots, Markdown, patches, TAR evidence, logs, lock files, and directory claims.
- A full move to SQLite is not justified by current scale and would make evidence harder to inspect and harvest.
- Best first candidate is a **rebuildable SQLite observer index** derived from validated canonical telemetry. JSONL remains authoritative, and deleting the database is a complete rollback.
- Later candidate is authoritative controller metadata: run state, telemetry, idempotency, publication, and artifact metadata. This requires an explicit architecture decision because it changes recovery and acceptance boundaries.
- Keep raw evidence as files: agent events, Pi transcripts, receipts, envelopes, plans, issues, patches, logs, hashes, and TAR archives.
- Before implementation, benchmark observer behavior with synthetic history and verify SQLite behavior under Node `22.19`, pinned remote Node `24.15`, and Bun `1.3.14` standalone binaries on supported operating systems.

## Decision summary

SQLite is a good fit for structured control data that needs transactions, constraints, indexes, cross-run queries, and retention. Files remain a better fit for immutable or append-oriented evidence that humans and controller harvest code inspect, copy, hash, and archive per run.

Recommended direction:

1. Keep current storage until a measured query, recovery, or retention need appears.
2. If adopting SQLite now, use it only as a disposable observer projection.
3. Promote SQLite to controller authority only after the projection proves useful and recovery semantics are designed and tested.
4. Do not put large evidence bodies or transcripts into database without a separate demonstrated need.

## Current storage map

### Canonical host telemetry

Path: `.maquila/telemetry/<run-id>.jsonl`

Purpose: controller-owned safe live event ledger used by run status and observer APIs.

Key behavior:

- `src/telemetry.ts:410-569` reads the complete ledger, ignores an incomplete trailing line, validates every event, and enforces gap-free sequence and lifecycle semantics.
- `src/telemetry.ts:577-750` replays existing telemetry when opening a writer, truncates an incomplete tail, validates each append, enforces line and file limits, and appends with `flush: true`.
- `src/run-status.ts` folds the complete event list into one current status.
- `src/observer/server.ts:59-78` lists telemetry files and loads complete ledgers.
- `src/observer/server.ts:166-208` folds every listed run before sorting and limiting results; event pagination still parses the full selected ledger before filtering by cursor.

This is append-only evidence with query-heavy readers. It is the clearest SQLite candidate.

### Agent-run evidence

Paths under `.maquila/runs/<run-id>/`:

- `events.jsonl`
- `sessions/*.jsonl`
- `receipt.json`
- `envelope.json`
- `lifecycle.json`
- `verification.json`
- `issue.md`
- `plan.md`
- `review-diff.sha256`

`src/run-artifacts.ts:14-38` creates these run directories, appends raw events, and writes JSON snapshots through temporary-file rename. Pi owns transcript format. Controller harvest code later verifies expected files and archives the evidence tree.

These files are normally read or harvested by run, not queried across all runs. They are poor replacement candidates. A future database may index their metadata without storing their contents.

### Controller state and evidence

Paths under `.maquila/controllers/<run-id>/` include:

- `controller-state.json`
- `receipt.json`
- `intake.json`
- `runtime.json`
- `bootstrap.json`
- `remote-runs.json`
- `publication.json`
- `issue.md`
- `change.patch`
- `evidence.tar` or `failure-evidence.tar`
- extracted remote evidence and its manifest

`src/run-state.ts:174-317` strictly validates controller state, publishes snapshots through temporary-file rename, checks legal transitions, and records VM cleanup state. `src/controller.ts` writes the remaining evidence and publication artifacts.

Structured controller metadata is a later SQLite candidate. Patches, archives, Markdown, and extracted evidence should remain files.

### Ownership, claims, and process records

Other durable paths include:

- `.maquila/controllers/.idempotency/<hash>/run-id`
- `.maquila/attempts/<run-id>/recovery.json`
- `.maquila/controller.lock`
- `.maquila/controller.lock.acquire/owner.json`
- `.maquila/launches/<run-id>/accepted.json`
- `.maquila/launches/<run-id>/termination-unconfirmed.json`
- `.maquila/observer.json`
- controller and observer stdout/stderr logs

These records coordinate process ownership and crash recovery. Do not replace controller lock, observer ownership, or detached-launch handshake in the first SQLite slice. Moving idempotency claims later may be useful, but only together with controller state and equivalent restart tests.

## Observed local scale

Snapshot from this checkout on 2026-08-20:

- `.maquila`: about 11 MB total.
- Canonical host telemetry: 10 ledgers, 1,070 events, about 361 KB.
- JSON snapshots: 121 files, about 966 KB.
- All JSONL, including harvested agent events and transcripts: 40 files, about 3.8 MB.
- TAR evidence: about 6 MB.

This is diagnostic evidence, not a permanent benchmark. It shows no current storage or query pressure. Most disk use comes from evidence archives and transcripts, so converting host telemetry to SQLite would not materially reduce disk use.

## What SQLite would improve

### Atomic structured changes

A transaction can commit related database records together or roll them all back. A future authoritative store could atomically update run state, append a terminal event, record publication metadata, and release an idempotency claim.

A SQLite transaction cannot include external patch, Markdown, or TAR writes. Those still need explicit ordering, hashing, and failure handling.

### Indexed cross-run queries

SQLite can index run ID, status, phase, issue, repository, timestamps, idempotency key, and event sequence. Observer list and event APIs could avoid directory scans and full-ledger parsing on every request.

This becomes valuable when history grows, filters and analytics appear, or retention needs cross-run selection.

### Constraints

A database can enforce rules such as:

- unique `(run_id, seq)` events;
- unique active idempotency keys;
- foreign keys from events and artifacts to runs;
- required values and bounded status enums;
- indexed run and publication identities.

TypeScript validation must remain at trust boundaries. Database constraints add deterministic storage-level enforcement; they do not replace input validation or lifecycle semantics.

### Recovery and maintenance

SQLite provides journal-based crash recovery, integrity checking, online backup APIs, and `VACUUM INTO`. These are stronger general-purpose tools than scanning and reconciling related JSON records manually.

## Costs and risks

### Evidence becomes less transparent

JSONL and JSON work with text editors, `tail`, `grep`, hashing, and TAR. SQLite is a mutable binary database requiring SQL-aware tools. Neither format is tamper-evident by itself.

### Shared failure domain

Today controller state, canonical telemetry, process ownership, and harvested evidence use separate files and deliberate authority boundaries. One corrupt database could otherwise hide both workflow state and observability. Recovery currently prioritizes VM cleanup even when telemetry is corrupt or unavailable. Preserve that property.

### Schema migrations

SQLite supports a limited set of direct `ALTER TABLE` operations. Larger changes require a transactional table rebuild. Any authoritative database needs a versioned, fail-closed migration path and tests for upgrades from every supported schema version.

### WAL and filesystem behavior

Write-ahead logging allows readers and one writer to coexist, matching the serial-controller design. WAL relies on shared memory and does not work on network filesystems. Active state can include the database plus `-wal` and `-shm` files. Copying only the main database while it is active can lose committed data.

Use SQLite backup APIs or `VACUUM INTO` for live copies. Confirm `.maquila` is on reliable local storage before enabling WAL; otherwise reject unsupported placement or use a deliberately tested journal mode.

### Runtime variation

The repository supports Node `>=22.19.0`, pins Node `24.15.0` for remote execution, and builds a Bun `1.3.14` standalone executable. Node and Bun provide built-in SQLite APIs, so a new native dependency may be unnecessary. Their SQLite versions and API stability differ by runtime and operating system, especially when Bun uses the operating system SQLite on macOS.

Implementation must:

- verify `SELECT sqlite_version()` at startup;
- use only a documented common feature floor or fail closed;
- test both normal Node execution and Bun-compiled executable behavior;
- avoid SQLite JSONB or newer SQL features unless every supported runtime proves them;
- preserve mode `0600` files and mode `0700` containing directories.

## Candidate ranking

### Candidate 1: rebuildable observer projection

Risk: low. Recommended first slice.

Store only data needed by observer queries:

- validated telemetry events keyed by run and sequence;
- folded run summary and current status;
- publication and artifact metadata already present in safe telemetry;
- source ledger size or digest needed to detect stale projection data.

Keep canonical JSONL authoritative. Build or refresh the database only from `readTelemetry()` output. Invalid telemetry must still produce current `invalid` behavior rather than partially indexed results.

Benefits:

- demonstrates indexed list, filter, sort, and paging behavior;
- avoids changing controller acceptance or recovery authority;
- can be deleted and rebuilt;
- preserves existing API and evidence format;
- supplies realistic measurements before larger migration.

Do not introduce controller-to-database dual writes in this slice. Let one projection owner derive state from canonical ledgers, or define an equivalent single synchronization path, so a cache failure cannot affect run acceptance.

### Candidate 2: authoritative canonical telemetry

Risk: medium.

Replace `.maquila/telemetry/<run-id>.jsonl` as live query authority with an events table, while optionally exporting terminal per-run JSONL for evidence and compatibility.

Required parity:

- exact event schema and semantic validation;
- gap-free sequence and event ID rules;
- line/file cap equivalents or explicit replacement limits;
- one exceptional post-terminal cleanup reconciliation;
- malformed or inconsistent history reported as invalid;
- safe field and redaction contract;
- telemetry write failure still fails run safely while cleanup remains attempted;
- existing and legacy run compatibility.

This slice needs an architecture decision about whether exported JSONL remains canonical evidence or becomes a derived terminal artifact.

### Candidate 3: authoritative controller metadata

Risk: high. Highest long-term transaction value.

Possible structured records:

- runs and current state;
- VM and cleanup status;
- idempotency claims;
- canonical events;
- publication metadata;
- artifact names, sizes, and hashes.

Potential benefit is one transaction for state transition plus event plus related metadata. Main risk is coupling cleanup authority and observability into one failure domain. Keep patches, evidence archives, transcripts, and human-readable documents outside database.

Do not move controller lock or observer process ownership automatically. SQLite serializes database writes but does not prove that a PID owns whole controller process or external VM lifecycle.

### Candidate 4: evidence metadata index

Risk: low to medium. Add only when search is requested.

Index artifact name, run, role, size, hash, status, and location. Keep artifact contents as files. This can answer evidence discovery questions without turning database into blob archive.

### Rejected initial candidates

Do not initially migrate:

- Pi session transcripts;
- raw role `events.jsonl`;
- receipts and envelopes as public evidence;
- issue and plan Markdown;
- patches and review hashes;
- evidence TAR files and extracted trees;
- stdout/stderr logs;
- controller and observer process locks.

No current cross-run query benefit offsets added backup, privacy, extraction, and compatibility work.

## Migration triggers

Start implementation when at least one trigger is measured or explicitly required:

- observer list or event API latency exceeds an agreed budget;
- retained history reaches hundreds or thousands of runs and full replay is material;
- users need filtering, analytics, or retention across runs;
- related JSON state and telemetry can diverge in a demonstrated failure;
- idempotency or recovery needs atomic multi-record updates;
- multiple tools need concurrent structured reads;
- integrity checks or online backup become operational requirements.

Do not migrate solely to reduce current disk usage or to introduce SQLite as technology.

## Suggested implementation slices

### Slice 0: benchmark and runtime spike

- Generate synthetic validated telemetry at 100, 1,000, and 10,000 runs.
- Measure observer run-list and event-page latency, CPU, and memory.
- Exercise a minimal built-in SQLite database under Node `22.19`, Node `24.15`, and Bun `1.3.14` standalone binaries on supported operating systems.
- Record SQLite versions, journal behavior, permissions, backup behavior, and executable compatibility.
- Decide measurable thresholds that justify Slice 1.

Stop if current JSONL behavior meets expected retention scale.

### Slice 1: disposable observer index

- Create private local database under `.maquila/`.
- Version schema from first commit.
- Import only fully validated canonical ledgers.
- Preserve observer HTTP contract and invalid/legacy behavior.
- Compare SQLite results against `foldRunStatus()` in tests.
- Rebuild on schema mismatch or projection corruption.
- Keep controller and canonical JSONL unchanged.

Rollback: stop reading projection and delete database.

### Slice 2: incremental projection and retention experiments

- Refresh projection without replaying unchanged ledgers.
- Add only approved filters or retention queries.
- Use SQLite backup API for diagnostics or migration fixtures.
- Prove stale-index detection and recovery after interrupted refresh.

Rollback remains database deletion and JSONL replay.

### Slice 3: authority decision

Before moving controller or telemetry authority, decide:

- canonical evidence format after terminal completion;
- transaction boundary between state, event, and artifact metadata;
- database corruption recovery versus VM cleanup authority;
- old-run import and downgrade policy;
- journal mode and supported filesystem contract;
- schema migration support window;
- backup and integrity-check schedule;
- whether one database serves all runs or one database exists per run.

Only then implement authoritative controller metadata or telemetry.

## Invariants to preserve

Any migration must keep these repository contracts:

- Controller owns orchestration and external authority.
- Planner and reviewer remain read-only; worker remains sole source writer.
- Model claims never replace deterministic evidence.
- Credentials and unsafe telemetry fields never enter retained public state.
- Successful state requires deterministic verification, reviewed patch binding, publication evidence, and completed cleanup.
- Recovery must attempt VM cleanup even when observability storage is corrupt or unavailable.
- Failed or timed-out role runs must not expose successful envelopes.
- Public artifact names remain safe basenames inside run directories.
- Existing evidence remains readable or has an explicit, tested migration path.
- Database and sidecar permissions remain private.
- No network-filesystem WAL use.
- Tests cover crash interruption, stale readers, busy writers, corrupt database, migration failure, backup, rebuild, and legacy files.

## Open questions

Resolve these before an implementation plan:

1. Expected retained run count and observer latency budget.
2. Whether `.maquila` may live on NFS, synchronized folders, or shared VM mounts.
3. Supported host operating systems for Bun standalone binaries.
4. Minimum SQLite version and exact SQL feature floor.
5. Whether SQLite begins as disposable projection or immediate authority.
6. Whether terminal JSONL export remains canonical evidence after an authority migration.
7. Retention policy for telemetry, transcripts, archives, and extracted evidence.
8. Backup, restore, and corruption-response ownership.
9. Whether database failure should fail active controller run, disable observer only, or depend on database role.

## Primary sources

- [Appropriate Uses For SQLite](https://www.sqlite.org/whentouse.html) — embedded/local fit, one-writer model, and client/server boundary.
- [Atomic Commit In SQLite](https://sqlite.org/atomiccommit.html) — transaction, journal, synchronization, and power-loss model.
- [Write-Ahead Logging](https://www.sqlite.org/wal.html) — concurrent readers, single writer, checkpoints, sidecars, network-filesystem restriction, and durability tradeoffs.
- [JSON Functions And Operators](https://sqlite.org/json1.html) — JSON text functions, JSONB version boundary, and indexing possibilities.
- [SQLite Online Backup API](https://www.sqlite.org/backup.html) — safe live database copying and `VACUUM INTO` alternatives.
- [ALTER TABLE](https://sqlite.org/lang_altertable.html) — supported schema changes and documented table-rebuild procedure.
- [How To Corrupt An SQLite Database File](https://www.sqlite.org/howtocorrupt.html) — locking, filesystem, copying, and synchronization failure modes.
- [Recovering Data From A Corrupt SQLite Database](https://www.sqlite.org/recovery.html) — salvage limitations and recovery tooling.
- [Implementation Limits For SQLite](https://www.sqlite.org/limits.html) — database, row, and value limits.
- [SQLite Is A Single-File Database](https://www.sqlite.org/onefile.html) — file format and portability claims.
- [Node.js `node:sqlite`](https://nodejs.org/api/sqlite.html) — built-in Node API, version history, timeout, and backup support.
- [Bun SQLite](https://bun.sh/docs/api/sqlite) — Bun API, transactions, WAL guidance, and runtime-specific behavior.
- [Bun issue 31247](https://github.com/oven-sh/bun/issues/31247) — reported Bun/macOS system SQLite version discrepancy; verify against supported hosts rather than assuming bundled version.

## Evidence confidence

High confidence:

- current repository storage paths and reader/writer behavior;
- SQLite transaction, WAL, backup, locking, and migration characteristics documented by SQLite;
- current observer full-replay query shape;
- current local storage snapshot.

Needs implementation-time verification:

- exact SQLite version and features under every supported Node/Bun/OS combination;
- performance crossover point for this workload;
- filesystem placement in real deployments;
- final canonical evidence and authority decision.
