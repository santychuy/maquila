# Foundation checkpoint

Verified snapshot recorded 2026-08-17. This page describes current code and evidence. See [ARCHITECTURE.md](../ARCHITECTURE.md) and [envelopes](envelopes.md).

## Current boundary

Milestones 3A, 3B, and deterministic verification are complete:

- **3A runner:** generic `runAgent()` owns one bounded Pi session, isolated resources, events, receipts, artifacts, and cooperative timeout handling.
- **3B envelope kernel:** typed planner, worker, and reviewer schemas; structural and semantic validation; `submit_envelope`; one same-session correction; accepted envelope and receipt evidence.
- **Verification gate:** `src/verify.ts` fail-closed parses `factory.verify.json`, runs argv commands serially with `execFile` semantics, and applies an exact Git diff gate. Agent claims cannot override the structured result.

All three role schemas exist. Planner, worker, and reviewer lifecycle execution now runs locally with deterministic baseline, verification, Git, and independent review gates. Linear and GitHub clients can snapshot a `Todo` issue and exact base SHA without retaining credentials. Milestone 4 adds durable controller state and an injectable exe.dev OpenSSH adapter; it does not run agents in VMs or publish pull requests.

## Implemented primitives

- `src/agents.ts` loads and fail-closed validates Markdown agent definitions.
- `src/run-agent.ts` exposes generic `runAgent()` and records session, lifecycle events, receipt, timeout, and envelope results.
- `src/envelope.ts` defines role schemas, `parseEnvelope()`, correction prompt, submit tool, and planner rendering.
- `src/plan.ts` exposes the executable planner path and writes `plan.md` from its accepted planner envelope.
- `src/run-artifacts.ts` creates `.factory/runs/<run-id>/`, snapshots input, appends JSONL events, and writes JSON artifacts.
- `src/verify.ts` loads `factory.verify.json`, executes repository checks, and evaluates the exact Git diff gate.
- `src/worker.ts` runs the sole writer, deterministic verification, and a separate reviewer with aggregate lifecycle evidence.
- `src/linear.ts`, `src/github.ts`, and `src/intake.ts` validate and hash immutable external inputs without returning credentials.
- `src/run-state.ts` atomically stores fail-closed controller state with transition validation, idempotency checks, and orphan VM lookup.
- `src/exe.ts` provides tested command construction for exe.dev SSH, SCP, and retryable deletion without retaining credentials.

## Evidence

Local live run `4340fb3b-eb0b-4039-b014-f0343b05cb04` completed with a valid planner envelope, zero correction attempts, and `envelope_accepted`. Generated `.factory/` evidence is ignored by Git and is not linked from committed docs. Its receipt records the planner, `submit_envelope`, `plan.md`, and `envelope.json`. The run used a dirty checkout, so it is execution evidence, not clean-baseline proof. Older run notes remain historical and may use older receipt shapes.

## Milestone 4 limitations

State writes have no concurrent multi-process lock or restart/recovery engine. SSH timeouts and disconnects prove only local command failure, not that a remote process stopped. Live VM smoke testing remains a reviewed manual step; agents and publication are intentionally excluded.

## Local tooling

This repository uses pnpm `11.22.0`, pinned by `package.json` and recorded in `pnpm-lock.yaml`. Use `corepack enable` followed by `pnpm install --frozen-lockfile`; Node 25 and newer do not include Corepack, so install Corepack separately first. Do not restore an npm lockfile.

`pnpm check` is the full local gate: type-aware Oxlint, Oxfmt verification, TypeScript checking, build, and compiled tests. Oxlint enables correctness and suspicious rules with TypeScript, Oxc, Unicorn, import, Node, and Promise plugins. Tests turn off only `typescript/no-floating-promises` and `typescript/no-unsafe-type-assertion`; this keeps the type-aware policy balanced for test code without disabling the broader checks. Oxfmt uses its defaults; `pnpm format` writes them and `pnpm format:check` verifies them.

Husky is local only: pre-commit runs `pnpm exec lint-staged`, and pre-push runs `pnpm run check`. lint-staged runs `oxlint --fix` then Oxfmt on staged TypeScript and JavaScript files, and Oxfmt on staged JSON, Markdown, and YAML files. It preserves unstaged work while handling partial staging, and only its staged-file results enter the commit. Run the full gate before relying on these hooks.

`pnpm-workspace.yaml` keeps lifecycle builds disabled for `@google/genai` and `protobufjs` (`allowBuilds: false`); no package-specific build approval is granted. There is no hosted CI workflow: checks run locally through these commands and hooks.

## Tests

`pnpm test` covers role boundaries, envelopes, local worker/reviewer lifecycle failures, artifact safety, verification and Git gates, Linear/GitHub input validation, credential redaction, and deterministic intake hashes.

## Failure and security limits

Timeout is cooperative: the runner calls `session.abort()` and records `deadline_reached`; it is not an OS-enforced wall. Read-only tools do not prevent reads outside the repository, and source is sent to the model provider. No VM isolation, credential separation, or network policy exists.

## Next

Compose intake, state, exe.dev creation/bootstrap, local agent lifecycle, harvest, and unconditional cleanup in one controller command. Add restart reconciliation before GitHub publication.
