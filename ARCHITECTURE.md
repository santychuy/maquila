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
5. **Controller state:** atomic run state, idempotency, restart recovery, and canonical append-only telemetry.
6. **exe.dev lifecycle:** create, inspect, execute, harvest, destroy, orphan cleanup.
7. **Linear intake:** required template, Ready claim, approval and cancellation labels.
8. **GitHub publication:** controller-held bot authority, branch push, linked PR, no auto-merge.

## Current slice

Remote controller composition plus local observation are implemented. `factory run` snapshots a Linear `Todo` issue and GitHub base SHA, holds a single-host lock, reconciles abandoned VMs, bootstraps pinned runtimes in a fresh exe.dev VM, streams safe telemetry through deterministic phase boundaries, runs planner then sole-writer/verification/fresh-reviewer sessions, binds harvested evidence to reviewed patch, and destroys VM before `ready_for_publication`.

`factory run start` returns accepted run identity before completion. Persistent on-demand observer binds loopback, replays canonical host JSONL, and serves read-only run list/detail/event views. Factory-owned Pi skill routes start/status requests through these commands. Observer and skill hold no workflow authority.

RIFF-39 proved pre-observer remote composition live. New telemetry/observer path has deterministic local coverage but no credentialed exe.dev smoke proof yet. GitHub publication, fix pass, in-flight session resume, and controller-owned external-only delivery remain absent.

## Non-goals for v1

Generic workflow DSL, dynamic swarm, multiple writers, automatic merge, deployment, Temporal, and self-hosted sandbox fleet.
