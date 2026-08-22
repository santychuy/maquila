# Code-controlled workflows

Factory turns one accepted plan into a fixed, reviewable work order. Workflow behavior lives in TypeScript. Agents carry out bounded steps; they do not choose the recipe or accept their own work.

## Mental model

| Idea                     | Technical name   | Current source or artifact                                                    |
| ------------------------ | ---------------- | ----------------------------------------------------------------------------- |
| Trusted building plan    | recipe           | `feature-pr` in `src/workflows/feature-pr.ts` and `src/workflows/manifest.ts` |
| Run-specific work order  | manifest         | `workflow-manifest.json`                                                      |
| One ordered unit of work | block            | `implement`, `document`, `verify`, or `review`                                |
| Completion proof         | execution record | `workflow-execution.json`                                                     |

Controller is general contractor. It selects current built-in recipe, creates and pins work order, checks remote evidence, controls VM and credentials, and publishes only accepted work. Recipe and executor are separate so workflow policy can change without moving authority into prompts or configuration.

## Current `feature-pr` flow

Only one recipe exists. `plan` runs first. Accepted plan produces manifest. Serial executor then follows manifest order:

1. **plan** — read-only planner proposes allowed paths and checks. Unresolved decisions pause same run.
2. **implement** — worker changes approved non-`docs/` paths. For a docs-only plan, code records trusted `docs-only` skip instead.
3. **document** — documenter changes approved `docs/` paths. It cannot alter worker-owned content.
4. **verify** — code runs `factory.verify.json` commands and exact Git diff gate over aggregate change.
5. **review** — fresh read-only reviewer receives accepted plan, staged patch, and deterministic verification result.
6. **publish** — controller verifies harvested evidence and patch binding, destroys VM, applies patch against pinned base in temporary clone, then creates bot commit, branch, and ready-for-review PR.

`verify` is a block with deterministic evidence, not an agent session. Its execution entry uses primary role run ID: worker run for mixed work, documenter run for docs-only work. No synthetic verifier run exists.

Any failed or timed-out block stops later blocks. Reviewer `FAIL`, missing gate evidence, evidence mismatch, base drift, or patch hash mismatch blocks publication.

## Source map

| Change                                                           | Owning source                 |
| ---------------------------------------------------------------- | ----------------------------- |
| Shared step ID, actor, and phase identity                        | `src/workflow-step.ts`        |
| Recipe ID/version, path split, block order                       | `src/workflows/feature-pr.ts` |
| Manifest schema, generation, definition hash                     | `src/workflows/manifest.ts`   |
| Execution schema, run links, manifest and patch hashes           | `src/workflows/execution.ts`  |
| Serial block execution and local compatibility fallback          | `src/workflows/worker.ts`     |
| Host orchestration, remote sequence checks, harvest, publication | `src/controller.ts`           |
| Persisted workflow cursor and compatibility                      | `src/run-state.ts`            |
| VM stream frames                                                 | `src/remote-protocol.ts`      |
| Host event ledger                                                | `src/telemetry.ts`            |
| Status folding and current checkpoint                            | `src/run-status.ts`           |

Change concern in owner above. Keep IDs aligned through `workflowStep()` instead of copying actor/phase strings.

## Artifacts and bindings

Controller run lives at `.factory/controllers/<run-id>/`. Agent run evidence remains under `.factory/runs/<role-run-id>/`; host telemetry lives at `.factory/telemetry/<run-id>.jsonl`.

| Artifact                  |          Version | Binding                                                                                                                        |
| ------------------------- | ---------------: | ------------------------------------------------------------------------------------------------------------------------------ |
| `workflow-manifest.json`  |                1 | Recipe ID/version and definition SHA-256; planner run ID; pinned base SHA; exact allowed paths; ordered pending/skipped blocks |
| `workflow-execution.json` |                1 | SHA-256 of exact manifest JSON; completed role run IDs; trusted skip; SHA-256 of reviewed staged patch                         |
| `controller-state.json`   |        2 current | Recipe identity/hash, manifest hash after planning, latest step ID and attempt                                                 |
| Remote frames             |       protocol 2 | Gap-free sequence plus required step ID, actor, and phase identity                                                             |
| Host telemetry JSONL      | record version 1 | Gap-free host sequence; step-tagged phases validate matching step, actor, and phase                                            |

Primary run also holds `verification.json`, `review-diff.sha256`, `lifecycle.json`, and `workflow-execution.json`. Controller harvest checks expected run set, receipts, envelopes, ownership, verification, reviewer verdict, base SHA, and reviewed patch. `evidence-manifest.json` hashes harvested remote evidence files.

Hashes prove internal consistency among captured values. VM evidence is not authentic against a compromised VM: VM processes have OS-level access and could forge internally consistent evidence. Use trusted, non-sensitive repositories.

## Controller, protocol, and observer

New controller state uses v2: broad host states include `executing`, while `workflow.currentStepId` and `attempt` hold recipe progress. State v1 remains readable and resumable for retained decision waits; it is not silently rewritten to v2.

Remote protocol v2 requires every phase/activity event to carry valid step identity. Parser rejects v1 frames, mixed old/new binaries, actor/phase mismatches, sequence gaps, extra data after result, and missing terminal result. Controller also checks expected serial phase order and requires gate/review outcome events before accepting completed result.

Telemetry copies safe activity into append-only host JSONL. `run status` folds latest `currentStepId`; it keeps `plan` visible during engineer wait and `review` visible through cleanup and publication. Observer displays this as workflow checkpoint. Observer remains read-only and has no workflow authority.

## Local compatibility path

`factory pi worker` accepts controller-supplied manifest. If omitted, `runWorkerLifecycle()` derives equivalent `feature-pr` manifest from local planner envelope and uses planner ID `local`. This is development and compatibility behavior. During `factory run`, controller-generated host `workflow-manifest.json` is canonical and is copied into VM.

## Modify `feature-pr` safely

1. Change recipe policy or order in `src/workflows/feature-pr.ts` and `src/workflows/manifest.ts`.
2. Update strict manifest/execution schemas and hashes when contract changes.
3. Update serial dispatch in `src/workflows/worker.ts` only when block behavior changes.
4. Update controller expected remote sequence, state cursor rules, and harvest checks together.
5. Update protocol, telemetry, status, and observer only when step identity or display changes.
6. Add smallest tests covering success, trusted skip, tampering, failure stop, state compatibility, protocol rejection, and displayed checkpoint.
7. Update this page and [foundation checkpoint](foundation-checkpoint.md).

### Before adding a second recipe

No second recipe, selector, or dynamic registry exists. A future second recipe needs deliberate code review of:

- controller-owned selection rule and immutable input used by it;
- unique recipe ID/version and definition hash;
- strict manifest and execution schemas;
- allowed blocks, order, actors, write ownership, skip rules, and retries;
- state cursor transitions and resume compatibility;
- protocol sequence and evidence requirements;
- harvest and publication acceptance;
- telemetry/status/observer meaning;
- complete failure and tamper tests.

Do not solve this with YAML, a DSL, plugins, inheritance, or user-authored workflow logic.

## Invariants

- Controller owns selection, state, acceptance, credentials, cleanup, and publication.
- Recipe and generated manifest are code-owned; user input cannot add or reorder blocks.
- Executor is serial. No parallel writers or DAG.
- Worker and documenter have disjoint approved paths.
- Deterministic verification and fresh review cover same aggregate patch.
- Execution record must match manifest and reviewed patch before harvest or publication.
- Agent envelopes are claims, never acceptance evidence by themselves.
- Human owns merge or rejection.

## Checks

Run focused workflow checks, then full gate:

```bash
bun run build:js
node --test dist/test/feature-pr.test.js dist/test/workflow-manifest.test.js dist/test/workflow-execution.test.js dist/test/worker.test.js dist/test/run-state.test.js dist/test/remote-protocol.test.js dist/test/telemetry.test.js dist/test/run-status.test.js dist/test/observer.test.js dist/test/controller.test.js
bun run format:check
bun run check
git diff --check
```
