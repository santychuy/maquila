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
- Executable local worker/reviewer lifecycle: `factory pi worker` with fresh reviewer session and deterministic verification.
- Deterministic verification: `factory.verify.json` argv commands plus exact Git diff gate (`src/verify.ts`).
- Controller-side Linear `Todo` issue and GitHub base-SHA snapshot primitives with credential-free hashes.
- Executable `factory run`: single-host lock, restart cleanup, pinned Node/Bun bootstrap, remote planner/worker/verification/reviewer, evidence and patch harvest, VM destruction, then controller-side bot branch and ready-for-review pull-request publication.
- Strict host telemetry with streaming remote phase/activity frames, accepted detached `run start`, and read-only `run status`.
- Managed loopback observer server/UI with replay/cursor polling, human `factory dashboard` startup alias, and factory-owned `.pi/skills/software-factory` command routing.
- Global `factory` executable through a Bun-compiled binary and `bun link`, with cwd target inference, `--target` override, human output, and explicit `--json` mode.
- `factory setup` and `factory doctor` for strict XDG config, optional Linear `op://` reference, optional user-scope Pi skill, credential checks, and remediation.
- Controller-side credential precedence for GitHub (`GITHUB_TOKEN`, `GH_TOKEN`, `gh auth token`) and Linear (`LINEAR_API_TOKEN`, then `op read`); optional exe.dev identity with OpenSSH config/agent support and no agent forwarding.

Not implemented yet:

- Fix pass and in-flight session resume.
- Planning outcomes delivered only to controller-owned external surfaces; current success still requires a non-empty repository diff.
- Guaranteed hard termination when exe.dev cleanup itself is unavailable.
- Runtime state is still stored under the Factory checkout. Linear OAuth, native keychain storage, and credential profiles are not implemented.

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
- `src/verify.ts` — fail-closed `factory.verify.json` parsing, command execution, exact Git gate.
- `src/linear.ts`, `src/github.ts`, and `src/intake.ts` — immutable external input snapshots, idempotency hash, and controller-side GitHub publication.
- `src/run-state.ts` and `src/exe.ts` — atomic PoC state plus tested exe.dev SSH/SCP command boundaries.
- `src/controller-lock.ts` and `src/controller.ts` — serial controller ownership, restart reconciliation, remote execution, harvest, and cleanup.
- `src/telemetry.ts`, `src/remote-protocol.ts`, `src/run-launcher.ts`, and `src/run-status.ts` — bounded live event contract, detached accepted start, and safe status replay.
- `src/observer.ts` and `src/observer-ui.ts` — loopback-only read API, managed server ownership, and accessible polling dashboard.
- `src/cli.ts` — `agents list`, setup/doctor, local Pi commands, remote run commands, human dashboard alias, observer machine commands, and exit-code handling.
- `factory.verify.json` — this repository's argv verification commands.
- `agents/*.md` — role metadata in YAML frontmatter and role system prompt in Markdown body.
- `test/*.test.ts` — Node test-runner coverage for CLI, role boundaries, envelopes, failures, and artifact safety.
- `docs/envelopes.md` — envelope contract and limitations.
- `docs/foundation-checkpoint.md` — evidence-backed implementation checkpoint.
- `examples/issue.md` — sample feature issue.

Generated `dist/`, `node_modules/`, and `.factory/` content is ignored. Do not edit or commit it.

## Development Commands

Requires Bun `1.3.14` and Node.js `>=22.19.0`.

```bash
bun install --frozen-lockfile
bun run build
bun run test
bun run lint
bun run format:check
bun run check
```

The repository pins Bun through `packageManager` and commits `bun.lock`. `bun run build` emits compiled JavaScript plus the current-platform standalone `dist/factory` executable.

`bun run check` is the required full local gate. It runs type-aware Oxlint, verifies Oxfmt output, type-checks, runs compiled Node tests, builds the standalone binary, and smoke-checks its help path.

Useful CLI checks after building:

```bash
bun run factory -- agents list
bun run factory -- pi plan \
  --repo /absolute/path/to/repository \
  --issue ./examples/issue.md \
  --model provider/model \
  --timeout-seconds 300
factory setup
factory doctor
cd /absolute/path/to/repository
factory dashboard
factory run start --issue RIFF-52
```

Planner execution requires Pi authentication for the selected model. It writes evidence under `.factory/` relative to the directory where the command runs. Exit codes are `0` for completion, `1` for failure, and `124` for timeout.

## Code Conventions

- TypeScript, ESM, `NodeNext`, strict mode, and `noUncheckedIndexedAccess` are mandatory.
- Oxfmt defaults are canonical. Run `bun run format`; verify with `bun run format:check`.
- Oxlint enforces correctness and suspicious rules with type-aware TypeScript, Oxc, Unicorn, import, Node, and Promise plugins. Fix only safe findings with `bun run lint:fix`.
- Use `.js` extensions in relative TypeScript imports so compiled ESM resolves correctly.
- Prefer Node standard library and existing dependencies over new abstractions or packages.
- Keep changes focused on the next proven slice; do not prebuild later architecture milestones.
- Validate trust-boundary input fail-closed. Reject unknown fields, unsafe paths, unsupported tools, and inconsistent states.
- Keep role claims separate from acceptance logic. A valid envelope proves shape and internal consistency, not truth.
- Preserve evidence on every terminal path, including setup failure and timeout.
- Keep public artifact names as safe basenames that exist inside run directory.
- Write JSON evidence atomically where current helpers provide that behavior.
- Use Bun only for package management. Update `bun.lock` whenever dependency metadata changes; never add npm or pnpm lockfiles.
- Keep dependency lifecycle scripts blocked with an empty `trustedDependencies` list. Do not trust a dependency without reviewing its exact scripts.

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

Husky installs through the `prepare` script. Pre-commit runs lint-staged through `bunx`, which applies safe Oxlint fixes and Oxfmt only to staged supported files. Pre-push runs `bun run check`. Hooks are local safeguards, not permission to skip the full gate. Bypass only for recovery, then run the missed command manually.

## Testing Expectations

Use `node:test` and `node:assert/strict`, matching existing tests. Add the smallest test that proves changed behavior or protects an invariant. For filesystem tests, use temporary directories and clean them in `finally` blocks.

Before finishing:

1. Run focused tests while developing.
2. Run `bun run check`.
3. Confirm generated files remain untracked.
4. Reconcile documentation with implemented code, especially when a milestone moves from planned to current.

## Scope Discipline

v1 intentionally excludes generic workflow DSLs, dynamic swarms, multiple writers, automatic merge, deployment, Temporal, and a self-hosted sandbox fleet. Local read-only observer is the approved exception now implemented. Do not add other excluded scope without an explicit architecture decision. Build in `ARCHITECTURE.md` order and keep current-state docs precise.
