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

## Local tooling

This repository uses pnpm `11.22.0`, pinned by `package.json` and recorded in `pnpm-lock.yaml`. Use `corepack enable` followed by `pnpm install --frozen-lockfile`; Node 25 and newer do not include Corepack, so install Corepack separately first. Do not restore an npm lockfile.

`pnpm check` is the full local gate: type-aware Oxlint, Oxfmt verification, TypeScript checking, build, and compiled tests. Oxlint enables correctness and suspicious rules with TypeScript, Oxc, Unicorn, import, Node, and Promise plugins. Tests turn off only `typescript/no-floating-promises` and `typescript/no-unsafe-type-assertion`; this keeps the type-aware policy balanced for test code without disabling the broader checks. Oxfmt uses its defaults; `pnpm format` writes them and `pnpm format:check` verifies them.

Husky is local only: pre-commit runs `pnpm exec lint-staged`, and pre-push runs `pnpm run check`. lint-staged runs `oxlint --fix` then Oxfmt on staged TypeScript and JavaScript files, and Oxfmt on staged JSON, Markdown, and YAML files. It preserves unstaged work while handling partial staging, and only its staged-file results enter the commit. Run the full gate before relying on these hooks.

`pnpm-workspace.yaml` keeps lifecycle builds disabled for `@google/genai` and `protobufjs` (`allowBuilds: false`); no package-specific build approval is granted. There is no hosted CI workflow: checks run locally through these commands and hooks.

## Tests

`pnpm test` passes 19 tests. Coverage includes role boundaries, schema and access failures, envelope structure and semantics, submit flow, correction prompt, timeout/setup failure, and artifact-name safety.

## Failure and security limits

Timeout is cooperative: the runner calls `session.abort()` and records `deadline_reached`; it is not an OS-enforced wall. Read-only tools do not prevent reads outside the repository, and source is sent to the model provider. No VM isolation, credential separation, or network policy exists.

## Next

Build deterministic verification and exact diff gates, then wire worker and reviewer execution with their write and review gates. Controller state, VM lifecycle, Linear intake, and GitHub publication follow later.
