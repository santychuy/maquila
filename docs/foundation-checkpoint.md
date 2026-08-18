# Foundation checkpoint

Verified snapshot recorded 2026-08-17. This page describes current code and evidence. See [ARCHITECTURE.md](../ARCHITECTURE.md) and [envelopes](envelopes.md).

## Current boundary

Milestones through remote controller composition are complete:

- **3A runner:** generic `runAgent()` owns one bounded Pi session, isolated resources, events, receipts, artifacts, and cooperative timeout handling.
- **3B envelope kernel:** typed planner, worker, and reviewer schemas; structural and semantic validation; `submit_envelope`; one same-session correction; accepted envelope and receipt evidence.
- **Verification gate:** `src/verify.ts` fail-closed parses `factory.verify.json`, runs argv commands serially with `execFile` semantics, and applies an exact Git diff gate. Agent claims cannot override the structured result.

All three role schemas run locally and through `factory run` in a fresh exe.dev VM. The controller snapshots immutable intake, serializes execution with a local lock, reconciles abandoned controller VMs, bootstraps pinned Node and target runtimes, invokes planner/worker/reviewer sessions, validates deterministic and review evidence, harvests a binary patch, and destroys the VM before reporting `ready_for_publication`. It does not publish pull requests.

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
- `src/controller-lock.ts` and `src/controller.ts` provide single-host ownership, restart cleanup, remote bootstrap/lifecycle, fail-closed evidence harvest, and unconditional cleanup.

## Evidence

Live controller run `fa7b5de1-8125-469f-b723-5db21243d783` completed RIFF-39 against Bookbounce SHA `04c6e9a5efa53727f2f0959e0e6ca4a3639b38c7`. Planner, worker, and fresh reviewer receipts and transcripts were harvested; `bun run validate` passed with 130 tests passed, one integration test skipped, and zero failures; the exact Git gate allowed only the planned assessment artifact; reviewer verdict was `PASS`; cleanup was recorded complete; exe.dev listed zero VMs; controller evidence contained neither controller token. No Bookbounce commit, branch, push, or PR was created. Generated `.factory/` evidence remains ignored by Git.

## Controller limitations

The lock and recovery model is single-host and serial. A timed-out SSH command may continue remotely until VM destruction succeeds; cleanup cannot be guaranteed while exe.dev control-plane deletion is unavailable. The controller restarts failed runs rather than resuming in-flight agent sessions. Success currently requires a non-empty repository diff, so a planning outcome delivered only to Linear or another controller-owned external surface needs a later delivery contract. Agents still have OS-level access inside the VM; use trusted, non-sensitive repositories.

## Local tooling

This repository uses pnpm `11.22.0`, pinned by `package.json` and recorded in `pnpm-lock.yaml`. Use `corepack enable` followed by `pnpm install --frozen-lockfile`; Node 25 and newer do not include Corepack, so install Corepack separately first. Do not restore an npm lockfile.

`pnpm check` is the full local gate: type-aware Oxlint, Oxfmt verification, TypeScript checking, build, and compiled tests. Oxlint enables correctness and suspicious rules with TypeScript, Oxc, Unicorn, import, Node, and Promise plugins. Tests turn off only `typescript/no-floating-promises` and `typescript/no-unsafe-type-assertion`; this keeps the type-aware policy balanced for test code without disabling the broader checks. Oxfmt uses its defaults; `pnpm format` writes them and `pnpm format:check` verifies them.

Husky is local only: pre-commit runs `pnpm exec lint-staged`, and pre-push runs `pnpm run check`. lint-staged runs `oxlint --fix` then Oxfmt on staged TypeScript and JavaScript files, and Oxfmt on staged JSON, Markdown, and YAML files. It preserves unstaged work while handling partial staging, and only its staged-file results enter the commit. Run the full gate before relying on these hooks.

`pnpm-workspace.yaml` keeps lifecycle builds disabled for `@google/genai` and `protobufjs` (`allowBuilds: false`); no package-specific build approval is granted. There is no hosted CI workflow: checks run locally through these commands and hooks.

## Tests

`pnpm test` covers role boundaries, envelopes, local worker/reviewer lifecycle failures, controller lock/recovery and fake remote lifecycle paths, tar and patch trust boundaries, artifact safety, verification and Git gates, Linear/GitHub input validation, credential redaction, and deterministic intake hashes.

## Failure and security limits

Agent timeout is cooperative: the runner calls `session.abort()` and records `deadline_reached`. The controller then destroys its VM, which is the hard cancellation boundary when exe.dev deletion is available. Read-only tools do not prevent reads outside the repository, and source is sent to the configured model provider. VM isolation keeps Linear and GitHub write credentials controller-side, but no restrictive in-VM network or filesystem sandbox exists.

## Next

Define a planning-output/delivery contract so the planner can choose repository changes versus controller-owned external artifacts. Then add controller-side branch push and draft PR publication for repository outcomes. In-flight session resume remains out of scope.
