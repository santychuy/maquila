# Software Factory Blueprint

## Contract

A validated Linear feature issue triggers a local controller. Controller runs bounded Pi sessions inside one fresh exe.dev VM. Code opens a bot pull request only after deterministic checks and independent review pass. Human owns merge or rejection.

## Authority boundaries

- Controller owns workflow state, deadlines, budgets, approvals, cancellation, VM lifecycle, publication commits, and pull requests.
- VM owns source checkout, Pi sessions, edits, verification, review, and raw evidence.
- Planner and reviewer are read-only. Worker and documenter write sequentially with disjoint authority: worker owns approved non-documentation paths, and documenter owns approved `docs/` paths.
- Linear credentials and GitHub write credentials stay outside VM. OpenRouter uses a dedicated capped key as deliberate transient exception, injected only into VM-local Pi config for agent calls, best-effort removed before VM destruction, and revoked if cleanup fails.
- Agent output is a proposal. Deterministic code decides acceptance.

## Target flow

```text
Linear Ready
  -> claim immutable issue snapshot
  -> create exe.dev VM at pinned base SHA
  -> plan
  -> risk approval when required
  -> implement non-documentation changes when planned
  -> update planned documentation
  -> verify aggregate diff
  -> independent review
  -> one fix pass when needed
  -> final verify and review
  -> harvest reviewed patch and evidence
  -> controller creates publication commit and opens PR
  -> human decision
```

## State machine

```text
queued -> planning -> awaiting_approval? -> implementing? -> documenting -> verifying
       -> reviewing -> fixing? -> final_verification -> publishing
       -> completed | failed | cancelled
```

## Build order

1. **Agent definitions:** validated Markdown plus YAML frontmatter contracts for planner, worker, documenter, and reviewer.
2. **Pi planner:** one SDK session, explicit model, definition-derived tools/prompt, deadline, durable receipt.
3. **Deterministic verification:** repository-defined commands and exact Git diff gate.
4. **Pi worker, documenter, and reviewer:** sequential disjoint-writer policy, fresh review context, typed outputs.
5. **Controller state:** atomic run state, idempotency, restart recovery, and canonical append-only telemetry.
6. **exe.dev lifecycle:** create, inspect, execute, harvest, destroy, orphan cleanup.
7. **Linear intake:** required template, Ready claim, approval and cancellation labels.
8. **GitHub publication:** controller-held bot authority, branch push, linked PR, no auto-merge.

## Current slice

Remote controller composition, local observation, GitHub publication, and OpenRouter-backed role execution are implemented. Each agent definition owns its pinned `openrouter/<provider>/<model>` identifier; current defaults are `openrouter/openai/gpt-5.6-terra`. Runtime does not ship a complete model catalog, so model availability remains an OpenRouter concern. VM is not a security sandbox. `factory run` snapshots a Linear `Todo` issue and GitHub base SHA, holds a single-host lock, reconciles abandoned VMs, bootstraps pinned runtimes in a fresh exe.dev VM, streams safe telemetry through deterministic phase boundaries, runs planner, sequential worker/documenter, verification, and fresh-reviewer sessions, binds harvested evidence to the reviewed patch, and destroys the VM. The trusted controller then checks the pinned base, applies the patch in a temporary clone, creates a deterministic bot branch and commit, opens a ready-for-review pull request, and records publication metadata before completion.

`factory run start` returns accepted run identity before completion. Persistent on-demand observer binds loopback, replays canonical host JSONL, serves read-only run list/detail/event views, and links the completed pull request. Factory-owned Pi skill routes start/status requests through these commands. Observer and skill hold no workflow authority.

RIFF-39 proved pre-publication remote composition live. Publication and observer paths have deterministic local coverage; a credentialed end-to-end publication smoke proof remains pending. Fix pass, in-flight session resume, and controller-owned external-only delivery remain absent.

## Non-goals for v1

Generic workflow DSL, dynamic swarm, concurrent writers, automatic merge, deployment, Temporal, and self-hosted sandbox fleet.
