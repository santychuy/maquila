# Software Factory Agent Guide

## Purpose

This repository is building a small, local software factory one proven slice at a time. Its intended contract is:

1. Accept a validated Linear feature issue.
2. Run bounded Pi agent sessions in a fresh exe.dev VM pinned to a repository SHA.
3. Plan, implement, verify, and independently review the change.
4. Publish a bot pull request only after deterministic gates pass.
5. Leave merge or rejection to a human.

Agent output is always a proposal or report. Deterministic controller code owns acceptance, workflow state, budgets, cancellation, VM lifecycle, and publication.

## Current Reality

Do not confuse the blueprint with implemented behavior.

Implemented now:

- Strict loading of `planner`, `worker`, and `reviewer` definitions from `agents/*.md`.
- Generic `runAgent()` Pi session execution with isolated resources, receipts, events, session transcripts, and cooperative timeouts.
- Typed planner, worker, and reviewer envelopes with structural and semantic validation.
- A `submit_envelope` tool and one same-session correction attempt.
- Executable read-only planner command: `factory pi plan`.

Not implemented yet:

- Worker or reviewer execution paths.
- Deterministic repository verification and exact Git diff gates.
- Durable controller state and restart recovery.
- exe.dev VM lifecycle and hard wall-clock termination.
- Linear intake or GitHub pull-request publication.

See `ARCHITECTURE.md` for target design and build order. See `docs/foundation-checkpoint.md` for verified current state.

## Authority and Safety Invariants

Preserve these boundaries:

- Controller owns orchestration and external authority.
- Planner and reviewer are read-only.
- Worker is sole writer.
- Linear credentials and GitHub write credentials stay outside execution VM.
- No agent may commit, push, publish, merge, or make unapproved product or architecture decisions.
- Human owns final merge or rejection.
- Model claims never replace deterministic evidence.

Current execution is not a security sandbox. Read-only tools stop mutation but do not prevent reads outside target repository or disclosure to model provider. Timeout calls `session.abort()` cooperatively; it cannot terminate a hung SDK call. Use only trusted, non-sensitive repositories until VM, credential, and network boundaries exist.

## Repository Map

- `src/agents.ts` — loads and fail-closed validates specialist definitions.
- `src/run-agent.ts` — generic Pi session runner, lifecycle capture, timeout, envelope flow, and receipts.
- `src/envelope.ts` — TypeBox schemas, semantic validation, correction prompt, submit tool, and planner rendering.
- `src/plan.ts` — validates planner inputs, snapshots issue context, runs planner, and writes `plan.md`.
- `src/run-artifacts.ts` — creates `.factory/runs/<run-id>/` and writes evidence.
- `src/cli.ts` — `agents list` and `pi plan` commands plus exit-code handling.
- `agents/*.md` — role metadata in YAML frontmatter and role system prompt in Markdown body.
- `test/*.test.ts` — Node test-runner coverage for CLI, role boundaries, envelopes, failures, and artifact safety.
- `docs/envelopes.md` — envelope contract and limitations.
- `docs/foundation-checkpoint.md` — evidence-backed implementation checkpoint.
- `examples/issue.md` — sample feature issue.

Generated `dist/`, `node_modules/`, and `.factory/` content is ignored. Do not edit or commit it.

## Development Commands

Requires Node.js `>=22.19.0`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm lint
pnpm format:check
pnpm check
```

The repository pins pnpm through `packageManager`. Node 25+ does not bundle Corepack; install Corepack separately there before running `corepack enable`.

`pnpm check` is the required full local gate. It runs type-aware Oxlint, verifies Oxfmt output, type-checks, builds, and runs compiled tests.

Useful CLI checks after building:

```bash
pnpm run factory -- agents list
pnpm run factory -- pi plan \
  --repo /absolute/path/to/repository \
  --issue ./examples/issue.md \
  --model provider/model \
  --timeout-seconds 300
```

Planner execution requires Pi authentication for the selected model. It writes evidence under `.factory/` relative to the directory where the command runs. Exit codes are `0` for completion, `1` for failure, and `124` for timeout.

## Code Conventions

- TypeScript, ESM, `NodeNext`, strict mode, and `noUncheckedIndexedAccess` are mandatory.
- Oxfmt defaults are canonical. Run `pnpm format`; verify with `pnpm format:check`.
- Oxlint enforces correctness and suspicious rules with type-aware TypeScript, Oxc, Unicorn, import, Node, and Promise plugins. Fix only safe findings with `pnpm lint:fix`.
- Use `.js` extensions in relative TypeScript imports so compiled ESM resolves correctly.
- Prefer Node standard library and existing dependencies over new abstractions or packages.
- Keep changes focused on the next proven slice; do not prebuild later architecture milestones.
- Validate trust-boundary input fail-closed. Reject unknown fields, unsafe paths, unsupported tools, and inconsistent states.
- Keep role claims separate from acceptance logic. A valid envelope proves shape and internal consistency, not truth.
- Preserve evidence on every terminal path, including setup failure and timeout.
- Keep public artifact names as safe basenames that exist inside run directory.
- Write JSON evidence atomically where current helpers provide that behavior.
- Use pnpm only. Update `pnpm-lock.yaml` whenever dependency metadata changes; never add an npm lockfile.
- Keep dependency lifecycle-script decisions explicit in `pnpm-workspace.yaml`. Do not broaden `allowBuilds` without reviewing the exact package scripts.

## Agent Definition Contract

Each `agents/<name>.md` file has YAML frontmatter plus a non-empty Markdown system prompt.

Allowed frontmatter fields only:

- `name`: lowercase kebab-case and identical to filename.
- `description`: non-empty role summary.
- `tools`: non-empty, unique subset of `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`.
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; defaults to `medium`.
- `access`: `read-only` or `writer`.

`bash`, `edit`, and `write` count as mutation tools. Read-only roles may have none. Writer roles must have at least one. Keep prompts explicit about goal, context, success, constraints, validation, output, and stop conditions.

## Envelope Contract

Roles finish through typed envelopes, not free-form prose:

- Planner: `summary`, `evidence`, `changes`, `verification`, `risks`, `decisionsNeeded`.
- Worker: `implemented`, `changedFiles`, `validation`, `openRisks`.
- Reviewer: `verdict`, `correct`, `blockingFindings`, `nonBlockingFindings`, `residualRisks`.

Schemas reject unknown properties. Nested strings must remain non-empty after trimming. A ready planner needs at least one change and verification step unless blocked by `decisionsNeeded`. Reviewer `PASS` requires no blockers; `FAIL` requires at least one blocker.

In envelope mode, `submit_envelope` must be the agent's final action. Invalid or missing submission receives one correction prompt in the same session; a second invalid result fails the run. Accepted envelopes are written to `envelope.json`; planner envelopes also render to `plan.md`.

## Evidence Contract

Each run lives at `.factory/runs/<run-id>/` and may contain:

- `issue.md` — snapshotted input.
- `events.jsonl` — concise lifecycle and envelope events.
- `sessions/` — Pi transcript data.
- `receipt.json` — status, model, role, timing, usage, artifacts, and failure context.
- `envelope.json` — accepted typed envelope only.
- `plan.md` — completed planner output only.

Failed or timed-out runs must not expose a successful envelope. Keep receipts honest: skipped, failed, or unavailable checks must never be reported as passing.

## Git Hooks

Husky installs through the `prepare` script. Pre-commit runs lint-staged, which applies safe Oxlint fixes and Oxfmt only to staged supported files. Pre-push runs `pnpm check`. Hooks are local safeguards, not permission to skip the full gate. Bypass only for recovery, then run the missed command manually.

## Testing Expectations

Use `node:test` and `node:assert/strict`, matching existing tests. Add the smallest test that proves changed behavior or protects an invariant. For filesystem tests, use temporary directories and clean them in `finally` blocks.

Before finishing:

1. Run focused tests while developing.
2. Run `pnpm check`.
3. Confirm generated files remain untracked.
4. Reconcile documentation with implemented code, especially when a milestone moves from planned to current.

## Scope Discipline

v1 intentionally excludes generic workflow DSLs, dynamic swarms, multiple writers, automatic merge, deployment, visualizers, Temporal, and a self-hosted sandbox fleet. Do not add them without an explicit architecture decision. Build in `ARCHITECTURE.md` order and keep current-state docs precise.
