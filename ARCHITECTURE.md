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
3. **Deterministic verification:** repository-defined commands and exact Git diff gate.
4. **Pi worker and reviewer:** sole-writer policy, fresh review context, typed outputs.
5. **Controller state:** SQLite runs and steps, idempotency, restart recovery, total budget.
6. **exe.dev lifecycle:** create, inspect, execute, harvest, destroy, orphan cleanup.
7. **Linear intake:** required template, Ready claim, approval and cancellation labels.
8. **GitHub publication:** controller-held bot authority, branch push, linked PR, no auto-merge.

## Current slice

Milestones through remote controller composition are proven. `factory run` snapshots a Linear `Todo` issue and GitHub base SHA, holds a single-host lock, reconciles abandoned VMs, bootstraps pinned runtimes in a fresh exe.dev VM, runs planner then sole-writer/verification/fresh-reviewer sessions, harvests evidence and a binary patch, and destroys the VM before `ready_for_publication`. RIFF-39 completed this path live with all three session transcripts, deterministic verification, reviewer `PASS`, credential scan, and zero remaining VMs. GitHub publication, fix pass, in-flight session resume, and controller-owned external-only delivery remain absent.

## Non-goals for v1

Generic workflow DSL, dynamic swarm, multiple writers, automatic merge, deployment, visualizer, Temporal, and self-hosted sandbox fleet.
