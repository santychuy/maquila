# Maquila Agent Guide

## Purpose

This repository is building a small, local maquila one proven slice at a time. Its intended contract is:

1. Accept a validated work item (the built-in path is Linear/Git/PR oriented).
2. Run bounded Pi agent sessions in a fresh exe.dev VM pinned to a repository SHA.
3. Plan, implement, verify, and independently review the change.
4. Publish a bot pull request only after deterministic gates pass.
5. Leave merge or rejection to a human.

Agent output is always a proposal or report. Deterministic controller code owns acceptance, workflow state, budgets, cancellation, VM lifecycle, and publication.

### SDK boundary

The package is prepared for public distribution as `@santychuy/maquila` under Apache-2.0. Registry publication must be verified separately. `src/index.ts` exports `createMaquila`, public request/result types, exactly four provider seams (`WorkItemProvider`, `SourceControlProvider`, `ExecutionProvider`, `EventSink`), their supporting contracts, and built-in Linear/GitHub/exe.dev constructors. `createMaquila(config).run(request)` is blocking. Do not expose internal `runMaquila` controls.

The SDK uses the exact absolute `stateDirectory` supplied by the host and never appends `.maquila`. The CLI uses `<Maquila checkout>/.maquila` for source compatibility, or `<host home>/.maquila` for installed packages. `MAQUILA_HOME` overrides the host home; otherwise installed packages use `$XDG_STATE_HOME/maquila` or `~/.local/state/maquila`. Detached controllers, status, batch, and observer must use the same home, never the target repository or package installation directory. Credentials belong only to instance configuration. They must not enter requests, results, state, or telemetry. EventSink receives only sanitized canonical telemetry after durable append and is best effort. Provider intake is canonical and can support non-Linear work items, but do not claim arbitrary SCM/workflow support or a GitHub Issues adapter.

The private code-controlled `feature-pr` recipe, controller authority, deterministic verification/review/publication gates, VM cleanup, artifact/state versions, and human merge remain mandatory. No public/custom recipe API exists.

## Current Reality

Do not confuse the blueprint with implemented behavior.

Implemented now:

- Strict loading of `planner`, `worker`, `documenter`, and `reviewer` definitions from `src/agents/*.md`.
- Generic `runAgent()` Pi session execution with isolated resources, receipts, events, session transcripts, and cooperative timeouts.
- Typed planner, worker, documenter, and reviewer envelopes with structural and semantic validation.
- A `submit_envelope` tool and one same-session correction attempt.
- Executable read-only planner command: `maquila pi plan`.
- Code-controlled `feature-pr` recipe: accepted plan becomes strict `workflow-manifest.json`; serial blocks run implement (or trusted docs-only skip), document, deterministic verify, and fresh review; completed work writes `workflow-execution.json` bound to manifest and reviewed patch.
- Executable local worker/documenter/reviewer lifecycle: `maquila pi worker`; worker owns approved non-doc paths, documenter owns approved docs paths, then deterministic verification and fresh review cover aggregate diff. Omitted local manifest uses compatibility/dev fallback; `maquila run` supplies canonical controller manifest.
- Deterministic verification: manifest-pinned argv commands plus exact Git diff gate (`src/verify.ts`).
- Controller-side assigned Linear `Todo` issue and GitHub base-SHA snapshot primitives with credential-free hashes.
- Planner decision handoff: blocked plans pause the same run as `awaiting_decision`; the controller retains the VM, checkpoints the completed planner session, removes transient model credentials, and polls a numbered Linear thread for a pinned-assignee `Decision:` reply before resuming the same session. Waits expire after 24 hours and allow at most three rounds.
- Executable `maquila run`: single-host lock, restart cleanup, pinned Node/Bun bootstrap, remote planner/worker/documenter/verification/reviewer, evidence and patch harvest, VM destruction, then controller-side bot branch and ready-for-review pull-request publication. A structured `model_request_failed` result during the post-plan lifecycle gets up to three controller-owned attempts under the same run ID; each retry preserves prior evidence and rebuilds a fresh VM at the pinned base SHA.
- Remote protocol v2 and host telemetry carry strict workflow step identity. New controller state v2 records recipe, manifest hash, step, and attempt; state v1 remains readable and resumable for retained decision waits. `run status` and observer expose current workflow checkpoint.
- Accepted detached `run start` and read-only `run status`.
- Detached serial `run batch` for 2–10 unique Linear issues, with preallocated independent run IDs, per-item controller authority, continue-after-result behavior, and read-only batch status.
- Managed loopback observer server/UI with replay/cursor polling, human `maquila dashboard` startup alias, and maquila-owned `.pi/skills/maquila` command routing.
- Global `maquila` executable through the package JavaScript entrypoint, with cwd target inference, `--target` override, human output, and explicit `--json` mode. Bun-compiled binaries remain development/VM artifacts, not the public npm payload. Packaged runtime archives preserve source commit and SHA-256 bindings; retained archives allow observer prompt checks without the original checkout.
- `maquila setup` and `maquila doctor` for strict XDG config, optional Linear and OpenRouter `op://` references, optional user-scope Pi skill, credential checks, and remediation. Opt-in `doctor --issue ID --require-label LABEL` validates assigned Todo intake and an exact label without starting work. Managed skill copies are repeatable when byte-identical; legacy managed links remain supported. This preflight is not a reservation or automatic trigger gate.
- OpenRouter execution for all four roles. Each `src/agents/*.md` definition must declare an authoritative pinned `openrouter/<provider>/<model>` identifier; current defaults are `openrouter/google/gemini-3.7-flash` for worker/documenter/reviewer and `openrouter/z-ai/glm-5.3` for planner. No complete model catalog is bundled; doctor and remote bootstrap validate against OpenRouter's live catalog. Agent requests cap maximum output at 16,384 tokens.
- Controller-side credential precedence for GitHub (`GITHUB_TOKEN`, `GH_TOKEN`, `gh auth token`) and Linear (`LINEAR_API_TOKEN`, then `op read`); optional exe.dev identity with OpenSSH config/agent support and no agent forwarding.

Not implemented yet:

- Fix pass and interrupted model-request resume. Current transient recovery restarts the complete post-plan lifecycle in a fresh VM; it does not resume the interrupted model request or retry timeouts and deterministic failures.
- General planning outcomes delivered only to controller-owned external surfaces; the implemented Linear handoff covers unresolved engineer decisions only, and successful publication still requires a non-empty repository diff.
- Guaranteed hard termination when exe.dev cleanup itself is unavailable.
- Registry publication and cross-platform release acceptance remain separate gates. Source-checkout controller state retains its old path; installed controller state uses a stable host home. Linear OAuth, native keychain storage, and credential profiles are not implemented.

See `ARCHITECTURE.md` for design boundaries, `docs/foundation-checkpoint.md` for verified current state, and `docs/workflows.md` before changing workflow behavior.

## Authority and Safety Invariants

Preserve these boundaries:

- Controller owns recipe selection, orchestration, manifest pinning, deterministic acceptance, cleanup, and external authority.
- Workflow recipes and blocks are trusted TypeScript. Generated manifests are work orders and evidence, not user-authored orchestration.
- Planner and reviewer are read-only.
- Worker and documenter are sequential disjoint writers: worker owns approved non-doc paths; documenter owns approved docs paths. Docs-only runs skip worker. Verification and reviewer cover aggregate diff.
- Linear credentials and GitHub write credentials stay outside execution VM. OpenRouter uses a dedicated capped key as deliberate transient VM exception; controller injects it into VM-local Pi config for agent calls.
- No agent may commit, push, publish, merge, or make unapproved product or architecture decisions.
- Human owns final merge or rejection.
- Model claims never replace deterministic evidence.

Current execution is not a security sandbox. Read-only tools stop mutation but do not prevent reads outside target repository or disclosure to model provider. Timeout calls `session.abort()` cooperatively; it cannot terminate a hung SDK call. Use only trusted, non-sensitive repositories until VM, credential, and network boundaries exist.

## Repository Map

- `src/agents/index.ts` — loads and fail-closed validates specialist definitions.
- `src/run-agent.ts` — generic Pi session runner, lifecycle capture, timeout, envelope flow, and receipts.
- `src/envelope.ts` — TypeBox schemas, semantic validation, correction prompt, submit tool, and planner rendering.
- `src/workflow-step.ts` — canonical workflow step, phase, and actor identity.
- `src/workflows/plan.ts` — validates planner inputs, snapshots issue context, runs planner, and writes `plan.md`.
- `src/workflows/feature-pr.ts`, `manifest.ts`, `execution.ts`, and `worker.ts` — code-owned recipe resolution, strict work-order/completion contracts, and serial block execution.
- `src/run-artifacts.ts` — creates `.maquila/runs/<run-id>/` and writes evidence.
- `src/verify.ts` — manifest-pinned command execution and exact Git gate.
- `src/integrations/linear.ts`, `src/integrations/github.ts`, and `src/intake.ts` — immutable external input snapshots, assigned-engineer decision comments/replies, idempotency hash, and controller-side GitHub publication.
- `src/run-state.ts` and `src/integrations/exe.ts` — atomic PoC state plus tested exe.dev SSH/SCP command boundaries.
- `src/controller-lock.ts`, `src/controller.ts`, and `src/controller-chain.ts` — serial controller ownership, restart reconciliation, remote execution, retained same-run decision polling/resume, and cleanup.
- `src/runs/evidence.ts` — Run evidence archive safety, harvest validation, and evidence manifest writing; `src/controller.ts` composes and re-exports it.
- `src/telemetry.ts`, `src/remote-protocol.ts`, `src/run-launcher.ts`, and `src/run-status.ts` — bounded live event contract, detached accepted start, and safe status replay.
- `src/runs/batch-state.ts` — strict batch coordination state, paths, validation, and atomic persistence; `src/run-batch.ts` re-exports that API and owns detached startup plus serial independent controller dispatch.
- `src/observer/` (`shared.ts`, `server.ts`, `process.ts`, `ui.ts`, `app.tsx`, generated `bundle.generated.ts`) — loopback-only read API, managed server ownership, and Preact polling dashboard bundled by Bun.
- `src/cli/index.ts` — `agents list`, setup/doctor, local Pi commands, remote run commands, human dashboard alias, observer machine commands, and exit-code handling.
- `src/agents/*.md` — role metadata in YAML frontmatter and role system prompt in Markdown body.
- `test/*.test.ts` — Node test-runner coverage for CLI, role boundaries, envelopes, failures, and artifact safety.
- `docs/envelopes.md` — envelope contract and limitations.
- `docs/workflows.md` — agent guide for workflow architecture, artifacts, invariants, and safe changes.
- `docs/foundation-checkpoint.md` — evidence-backed implementation checkpoint.
- `examples/issue.md` — sample feature issue.

Generated `dist/`, `node_modules/`, and `.maquila/` content is ignored. Do not edit or commit it.

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

The repository pins Bun through `packageManager` and commits `bun.lock`. `bun run build` emits compiled JavaScript plus the current-platform standalone `dist/maquila` executable.

`bun run check` is the required full local gate. It runs type-aware Oxlint, verifies Oxfmt output, type-checks, runs compiled Node tests, builds the standalone binary, and smoke-checks its help path.

Useful CLI checks after building:

```bash
bun run maquila -- agents list
bun run maquila -- pi plan \
  --repo /absolute/path/to/repository \
  --issue ./examples/issue.md \
  --timeout-seconds 300
maquila setup
maquila doctor
cd /absolute/path/to/repository
maquila dashboard
maquila run start --issue RIFF-52
```

Planner execution requires Pi authentication for the selected model. It writes evidence under `.maquila/` relative to the directory where the command runs. Exit codes are `0` for completion, `1` for failure, and `124` for timeout.

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

Each `src/agents/<name>.md` file has YAML frontmatter plus a non-empty Markdown system prompt.

Allowed frontmatter fields only:

- `name`: lowercase kebab-case and identical to filename.
- `description`: non-empty role summary.
- `model`: pinned OpenRouter identifier in `openrouter/<provider>/<model>` form; `latest` and `auto` aliases are rejected. This field is authoritative per agent.
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

Each role run lives at `.maquila/runs/<run-id>/` and may contain:

- `issue.md` — snapshotted input.
- `events.jsonl` — concise lifecycle and envelope events.
- `sessions/` — Pi transcript data.
- `receipt.json` — status, model, role, timing, usage, artifacts, and failure context.
- `envelope.json` — accepted typed envelope only.
- `plan.md` — completed planner output only.

Failed or timed-out runs must not expose a successful envelope. Keep receipts honest: skipped, failed, or unavailable checks must never be reported as passing.

Controller evidence lives at `.maquila/controllers/<run-id>/`. Current workflow artifacts include `workflow-manifest.json` version 2, harvested `workflow-execution.json` version 1, `controller-state.json` version 2, `change.patch`, `evidence-manifest.json`, and `publication.json` after publication. Host telemetry lives at `.maquila/telemetry/<run-id>.jsonl`. Batch coordination metadata lives at `.maquila/batches/<batch-id>/batch.json`; per-run evidence remains authoritative. Hash links prove consistency, not authenticity against a compromised VM.

## Git Hooks

Husky installs through the `prepare` script. Pre-commit runs lint-staged through `bunx`, which applies safe Oxlint fixes and Oxfmt only to staged supported files. Pre-push runs `bun run check`. Hooks are local safeguards, not permission to skip the full gate. Bypass only for recovery, then run the missed command manually.

## Testing Expectations

Use `node:test` and `node:assert/strict`, matching existing tests. Add the smallest test that proves changed behavior or protects an invariant. For filesystem tests, use temporary directories and clean them in `finally` blocks.

Before finishing:

1. Run focused tests while developing. Workflow changes must cover recipe, manifest, execution, state, protocol, telemetry/status, controller harvest, and observer checkpoint as applicable.
2. Run `bun run check`.
3. Confirm generated files remain untracked and no staged files remain.
4. Reconcile `docs/workflows.md` and current-state documentation with implemented code.

## Scope Discipline

v1 intentionally excludes generic workflow DSLs, dynamic swarms, multiple writers, automatic merge, deployment, Temporal, and a self-hosted sandbox fleet. Local read-only observer is the approved exception now implemented. Do not add other excluded scope without an explicit architecture decision. Build in `ARCHITECTURE.md` order and keep current-state docs precise.
