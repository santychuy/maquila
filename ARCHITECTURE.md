# Software Factory Blueprint

## Contract

A validated Linear feature issue triggers a local controller. Controller runs bounded Pi sessions inside one fresh exe.dev VM. Code opens a bot pull request only after deterministic checks and independent review pass. Human owns merge or rejection.

## Authority boundaries

- Controller owns workflow state, deadlines, budgets, approvals, cancellation, VM lifecycle, and publication.
- VM owns source checkout, Pi sessions, edits, verification, review, local commits, and raw evidence.
- Planner and reviewer are read-only. Worker is sole writer.
- Linear credentials and GitHub write credentials stay outside VM.
- Agent output is a proposal. Deterministic code decides acceptance.

## Target flow

```text
Linear Ready
  -> claim immutable issue snapshot
  -> create exe.dev VM at pinned base SHA
  -> plan
  -> risk approval when required
  -> implement
  -> verify
  -> independent review
  -> one fix pass when needed
  -> final verify and review
  -> harvest commit bundle and evidence
  -> controller bot opens PR
  -> human decision
```

## State machine

```text
queued -> planning -> awaiting_approval? -> implementing -> verifying
       -> reviewing -> fixing? -> final_verification -> publishing
       -> completed | failed | cancelled
```

## Build order

1. **Agent definitions:** validated Markdown plus YAML frontmatter contracts for planner, worker, and reviewer.
2. **Pi planner:** one SDK session, explicit model, definition-derived tools/prompt, deadline, durable receipt.
3. **Pi worker and reviewer:** sole-writer policy, fresh review context, typed outputs.
4. **Deterministic verification:** repository-defined commands and exact Git diff gate.
5. **Controller state:** SQLite runs and steps, idempotency, restart recovery, total budget.
6. **exe.dev lifecycle:** create, inspect, execute, harvest, destroy, orphan cleanup.
7. **Linear intake:** required template, Ready claim, approval and cancellation labels.
8. **GitHub publication:** controller-held bot authority, branch push, linked PR, no auto-merge.

## Current slice

Steps 1 and 2 exist. `factory agents list` validates three role contracts. `factory pi plan` proves planner definition, Pi SDK lifecycle, and evidence capture. Worker and reviewer are defined but intentionally not executable until write and review gates exist.

## Non-goals for v1

Generic workflow DSL, dynamic swarm, multiple writers, automatic merge, deployment, visualizer, Temporal, and self-hosted sandbox fleet.
