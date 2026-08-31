# Code-controlled workflows

Maquila turns one accepted plan into a fixed, reviewable work order. Workflow behavior lives in TypeScript. Agents carry out bounded steps; they do not choose the recipe or accept their own work.

## Providers and execution surfaces

The four provider seams supply external facts and bounded actions: work-item intake/decisions, Git/PR source control and publication, VM execution, and best-effort telemetry. Providers do not select recipes, accept work, or bypass controller gates. Canonical intake can normalize non-Linear work items; built-in integrations retain native Linear/GitHub evidence and historical compatibility. Phase 1 does not promise arbitrary SCM/workflow support.

The private SDK calls the same core through a blocking `run(request)`. The host owns queues and background lifetime. Detached execution, status, resume, and batch are CLI compatibility surfaces only. There is no public custom recipe API: `feature-pr` remains trusted TypeScript and code-controlled.

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
4. **verify** — code runs manifest-pinned `bun run check` and exact Git diff gate over aggregate change.
5. **review** — fresh read-only reviewer receives accepted plan, staged patch, and deterministic verification result.
6. **publish** — controller verifies harvested evidence and patch binding, destroys VM, applies patch against pinned base in temporary clone, then creates bot commit, branch, and ready-for-review PR.

`verify` is a block with deterministic evidence, not an agent session. Its execution entry uses primary role run ID: worker run for mixed work, documenter run for docs-only work. No synthetic verifier run exists.

A structured `model_request_failed` result during the post-plan lifecycle is the narrow exception to serial stop behavior. The controller preserves that attempt's remote evidence, destroys the VM, waits with bounded backoff, creates a replacement VM at the same pinned base SHA, restores the accepted planner evidence and manifest, and retries the complete post-plan lifecycle under the same controller run ID. It allows at most three total lifecycle attempts. Attempt number is persisted in controller state and telemetry.

All other failed or timed-out blocks stop later blocks. Invalid envelopes, generic agent failures, ownership violations, reviewer `FAIL`, missing gate evidence, failed verification, evidence mismatch, base drift, or patch hash mismatch block publication. A timeout is not retried because abort is cooperative and the prior remote command may still be running.

## Source map

A Run is one accepted issue's lifecycle, from intake through cleanup and publication.

| Capability                                              | Owning source                 |
| ------------------------------------------------------- | ----------------------------- |
| Shared step ID, actor, and phase identity               | `src/workflow-step.ts`        |
| Recipe ID/version, path split, block order              | `src/workflows/feature-pr.ts` |
| Manifest schema, generation, definition hash            | `src/workflows/manifest.ts`   |
| Execution schema, run links, manifest and patch hashes  | `src/workflows/execution.ts`  |
| Serial block execution and local compatibility fallback | `src/workflows/worker.ts`     |
| Run evidence archive safety and harvest validation      | `src/runs/evidence.ts`        |
| Batch coordination state and persistence                | `src/runs/batch-state.ts`     |
| Batch serial dispatch and detached startup              | `src/run-batch.ts`            |
| Host orchestration, remote sequence checks, publication | `src/controller.ts`           |
| Persisted workflow cursor and compatibility             | `src/run-state.ts`            |
| VM stream frames                                        | `src/remote-protocol.ts`      |
| Host event ledger                                       | `src/telemetry.ts`            |
| Status folding and current checkpoint                   | `src/run-status.ts`           |
| Local observer contracts, server, lifecycle, and UI     | `src/observer/`               |

`src/runs/evidence.ts` owns evidence archive safety and harvest validation. `src/runs/batch-state.ts` owns strict batch coordination state: paths, validation, and atomic persistence. `src/run-batch.ts` re-exports that API for compatibility and retains serial execution and detached launch. Controller still owns sequencing, credentials, VM lifecycle, cleanup, final acceptance, and publication.

Keep IDs aligned through `workflowStep()` instead of copying actor/phase strings.

## Artifacts and bindings

Controller run lives at `.maquila/controllers/<run-id>/`. Agent run evidence remains under `.maquila/runs/<role-run-id>/`; host telemetry lives at `.maquila/telemetry/<run-id>.jsonl`.

| Artifact                  |          Version | Binding                                                                                                                                                                 |
| ------------------------- | ---------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow-manifest.json`  |                2 | Recipe ID/version and definition SHA-256; planner run ID; pinned base SHA; exact allowed paths; ordered blocks with agent/code actor kinds and verifier code definition |
| `workflow-execution.json` |                1 | SHA-256 of exact manifest JSON; completed role run IDs; trusted skip; SHA-256 of reviewed staged patch                                                                  |
| `controller-state.json`   |        2 current | Recipe identity/hash, manifest hash after planning, latest step ID and attempt                                                                                          |
| Remote frames             |       protocol 2 | Gap-free sequence plus required step ID, actor, and phase identity                                                                                                      |
| Host telemetry JSONL      | record version 1 | Gap-free host sequence; step-tagged phases validate matching step, actor, and phase                                                                                     |

Primary run also holds `verification.json`, `review-diff.sha256`, `lifecycle.json`, and `workflow-execution.json`. During harvest, Run evidence code checks expected run set, receipts, envelopes, path ownership, verification, reviewer verdict, base SHA, and reviewed patch. `evidence-manifest.json` hashes harvested remote evidence files. Before a transient retry destroys its VM, the controller stores `workflow-attempt-<n>-evidence.tar` after size, secret, path, and archive-member checks. Final acceptance still uses only the successful attempt's exact run set.

Hashes prove internal consistency among captured values. VM evidence is not authentic against a compromised VM: VM processes have OS-level access and could forge internally consistent evidence. Use trusted, non-sensitive repositories.

## Controller, protocol, and observer

New controller state uses v2: broad host states include `executing`, while `workflow.currentStepId` and `attempt` hold recipe progress. State v1 remains readable and resumable for retained decision waits; it is not silently rewritten to v2.

Remote protocol v2 requires every phase/activity event to carry valid step identity. Parser rejects v1 frames, mixed old/new binaries, actor/phase mismatches, sequence gaps, extra data after result, and missing terminal result. Controller also checks expected serial phase order and requires gate/review outcome events before accepting completed result.

Telemetry copies safe activity into append-only host JSONL. `run status` folds latest `currentStepId`; it keeps `plan` visible during engineer wait and `review` visible through cleanup and publication. Observer displays this as workflow checkpoint. Observer remains read-only and has no workflow authority.

## Detached serial issue batches

`maquila run batch --issue ID --issue ID [common target options] [--json]` accepts 2–10 unique Linear issue IDs. It preallocates one independent UUID run ID per issue, then starts a detached coordinator. Coordinator runs items strictly serially in CLI order. An active run waiting for an engineer decision reports `awaiting_decision` through per-run status while its batch item remains `running`; later items remain queued. Failed or cancelled controller results do not stop later items. A controller that cannot start is a coordinator failure and leaves remaining items queued.

Each item remains authoritative for its own VM, Linear intake snapshot, evidence, idempotency, and pull request. Batch state is coordination metadata at `.maquila/batches/<batch-id>/batch.json`; inspect it with `maquila run batch status --batch-id UUID [--json]`. Batch state does not replace per-run state or evidence.

Batch has no parallelism, pause, reorder, cancel, or crash resume. A coordinator crash does not resume the batch.

## Local compatibility path

`maquila pi worker` accepts controller-supplied manifest. If omitted, `runWorkerLifecycle()` derives equivalent `feature-pr` manifest from local planner envelope and uses planner ID `local`. This is development and compatibility behavior. During `maquila run`, controller-generated host `workflow-manifest.json` is canonical and is copied into VM.

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

## Live happy-path scenario

`bun run e2e:live` replaces only Linear intake and GitHub publication. It reads `examples/e2e-live/issue.md`, snapshots the real `santychuy/maquila-e2e-fixture` base, then runs the real exe.dev VM, OpenRouter agents, manifest, writers, verifier, reviewer, harvest, and cleanup. Publication input is validated and retained as `publication-dry-run.json`; no branch or pull request is created.

The scenario keeps normal controller evidence and telemetry under `.maquila/`, so `maquila dashboard` and `maquila run status --run-id <id>` can inspect it. It requires GitHub read credentials, OpenRouter credentials, exe.dev access, and the private fixture's `maquila-e2e` GitHub integration attached to VM tag `santychuy-maquila-e2e-fixture`; it needs no Linear credential. Override the canonical fixture with `bun run e2e:live -- --repo OWNER/REPO --base-ref REF`. Each invocation gets a fresh synthetic issue UUID so completed idempotency claims do not block a rerun. A planner decision fails this first scenario because no Linear decision thread exists.

This is a credentialed development smoke test, not part of `bun run check`. Real model output and vendor availability make it rerunnable but not deterministic.

## Checks

Run focused workflow checks, then full gate:

```bash
bun run build:js
node --test dist/test/feature-pr.test.js dist/test/workflow-manifest.test.js dist/test/workflow-execution.test.js dist/test/worker.test.js dist/test/run-state.test.js dist/test/remote-protocol.test.js dist/test/telemetry.test.js dist/test/run-status.test.js dist/test/observer.test.js dist/test/controller.test.js
bun run format:check
bun run check
git diff --check
```
