# Foundation checkpoint

Verified snapshot recorded 2026-08-17. This page describes current code and evidence. See [ARCHITECTURE.md](../ARCHITECTURE.md) and [envelopes](envelopes.md).

## Current boundary

Milestones 3A and 3B are complete:

- **3A runner:** generic `runAgent()` owns one bounded Pi session, isolated resources, events, receipts, artifacts, and cooperative timeout handling.
- **3B envelope kernel:** typed planner, worker, and reviewer schemas; structural and semantic validation; `submit_envelope`; one same-session correction; accepted envelope and receipt evidence.

All three role schemas exist. Planner remains the only executable role. Worker and reviewer definitions and shapes exist, but no code runs them. No deterministic verification gate, controller, VM, intake, or publication flow exists.

## Implemented primitives

- `src/agents.ts` loads and fail-closed validates Markdown agent definitions.
- `src/run-agent.ts` exposes generic `runAgent()` and records session, lifecycle events, receipt, timeout, and envelope results.
- `src/envelope.ts` defines role schemas, `parseEnvelope()`, correction prompt, submit tool, and planner rendering.
- `src/plan.ts` exposes the executable planner path and writes `plan.md` from its accepted planner envelope.
- `src/run-artifacts.ts` creates `.factory/runs/<run-id>/`, snapshots input, appends JSONL events, and writes JSON artifacts.

## Evidence

Local live run `4340fb3b-eb0b-4039-b014-f0343b05cb04` completed with a valid planner envelope, zero correction attempts, and `envelope_accepted`. Generated `.factory/` evidence is ignored by Git and is not linked from committed docs. Its receipt records the planner, `submit_envelope`, `plan.md`, and `envelope.json`. The run used a dirty checkout, so it is execution evidence, not clean-baseline proof. Older run notes remain historical and may use older receipt shapes.

## Tests

`npm test` passes 19 tests. `npm run check` also passes TypeScript checking and the test suite. Coverage includes role boundaries, schema and access failures, envelope structure and semantics, submit flow, correction prompt, timeout/setup failure, and artifact-name safety.

## Failure and security limits

Timeout is cooperative: the runner calls `session.abort()` and records `deadline_reached`; it is not an OS-enforced wall. Read-only tools do not prevent reads outside the repository, and source is sent to the model provider. No VM isolation, credential separation, or network policy exists.

## Next

Build deterministic verification and exact diff gates, then wire worker and reviewer execution with their write and review gates. Controller state, VM lifecycle, Linear intake, and GitHub publication follow later.
