# Maquila Blueprint

## Contract

A validated Linear feature issue triggers a local controller. Controller runs bounded Pi sessions inside one fresh exe.dev VM. Code opens a bot pull request only after deterministic checks and independent review pass. Human owns merge or rejection.

## Authority boundaries

- Controller owns workflow state, deadlines, budgets, approvals, cancellation, VM lifecycle, publication commits, and pull requests.
- VM owns source checkout, Pi sessions, edits, verification, review, and raw evidence.
- Planner and reviewer are read-only. Worker and documenter write sequentially with disjoint authority: worker owns approved non-documentation paths, and documenter owns approved `docs/` paths.
- Linear credentials and GitHub write credentials stay outside VM. OpenRouter uses a dedicated capped key as deliberate transient exception, injected only into VM-local Pi config for agent calls and best-effort removed before VM destruction. Controller still destroys VM after removal failure; cleanup failure reports require manual revocation of dedicated key.
- Agent output is a proposal. Deterministic code decides acceptance.

## Modular workflow design

Workflow remains code-controlled. A trusted TypeScript **recipe** defines ordered work blocks and policy. After planning, controller generates a run-specific **manifest**: a work order and evidence record, not user-authored workflow logic. Serial executor follows that manifest. Successful execution writes a second record binding completed role runs to exact manifest and reviewed patch.

Controller is general contractor. It selects current built-in recipe, pins inputs, controls state and credentials, checks remote sequence and harvested evidence, destroys VM, and publishes. Agents propose or perform bounded work; they do not select recipe, accept evidence, commit, push, or merge.

Current `feature-pr` recipe runs `plan`, then `implement` when non-documentation work exists, `document`, deterministic `verify`, and fresh `review`. A docs-only manifest records trusted implementation skip. Verification may point to primary writer run because it is a code gate, not a synthetic agent run. Publication starts only after manifest, execution record, verification, reviewer verdict, base SHA, and reviewed patch agree.

See [code-controlled workflows](docs/workflows.md) for contracts, artifacts, and change guide.

## Current flow

```text
Linear Todo -> immutable intake -> fresh VM at pinned SHA -> plan
  -> implement? -> document -> verify -> review
  -> harvest and bind evidence -> destroy VM -> publish ready PR -> human decision
```

Planner decisions may pause and resume same run before manifest generation. Fix pass remains a target, not current behavior.

## Current controller state

New runs use controller state v2:

```text
intake -> creating_vm -> bootstrapping -> executing <-> awaiting_decision
       -> ready_for_publication -> publishing -> completed | failed | cancelled
```

Workflow cursor inside `executing` records current step and attempt. State v1 remains readable and can resume retained decision waits for compatibility.

## Build order

1. **Agent definitions:** validated Markdown plus YAML frontmatter contracts for planner, worker, documenter, and reviewer.
2. **Pi planner:** one SDK session, explicit model, definition-derived tools/prompt, deadline, durable receipt.
3. **Deterministic verification:** a first-class verifier code actor runs recipe-defined, manifest-pinned commands and the exact Git diff gate.
4. **Pi worker, documenter, and reviewer:** sequential disjoint-writer policy, fresh review context, typed outputs.
5. **Controller state:** atomic run state, idempotency, restart recovery, and canonical append-only telemetry.
6. **exe.dev lifecycle:** create, inspect, execute, harvest, destroy, orphan cleanup.
7. **Linear intake:** required template, Ready claim, approval and cancellation labels.
8. **GitHub publication:** controller-held bot authority, branch push, linked PR, no auto-merge.

## Current slice

Remote controller composition, local observation, GitHub publication, and OpenRouter-backed role execution are implemented. Each agent definition owns its pinned `openrouter/<provider>/<model>` identifier; current defaults are `openrouter/google/gemini-3.7-flash` for worker/documenter/reviewer and `openrouter/z-ai/glm-5.3` for planner. Runtime does not ship a complete model catalog; doctor and remote bootstrap validate pinned identifiers against OpenRouter's live catalog. VM is not a security sandbox. `maquila run` snapshots a Linear `Todo` issue and GitHub base SHA, holds a single-host lock, reconciles abandoned VMs, bootstraps pinned runtimes in a fresh exe.dev VM, streams safe telemetry through deterministic phase boundaries, runs planner, sequential worker/documenter, verification, and fresh-reviewer sessions, binds harvested evidence to the reviewed patch, and destroys the VM. The trusted controller then checks the pinned base, applies the patch in a temporary clone, creates a deterministic bot branch and commit, opens a ready-for-review pull request, and records publication metadata before completion.

`maquila run start` returns accepted run identity before completion. Persistent on-demand observer binds loopback, replays canonical host JSONL, serves read-only run list/detail/event views, and links the completed pull request. Maquila-owned Pi skill routes start/status requests through these commands. Observer and skill hold no workflow authority.

Assigned Linear issues also support a controller-owned decision path. A planner envelope with `decisionsNeeded` pauses the same run as `awaiting_decision`, retains the VM and idempotency claim, checkpoints the completed Pi planner session to controller-owned storage, removes the VM-local OpenRouter configuration, and creates a numbered Linear decision thread mentioning the request-time assignee. The detached controller releases its global lock while polling that thread. A valid pinned-assignee `Decision:` reply is atomically snapshotted; the controller reacquires the lock, fails closed on Linear or GitHub snapshot drift, restores only transient model configuration, and resumes the same planner session and VM. Waits expire after 24 hours and a run may request at most three decision rounds. This remains local polling, not a held model request or hosted webhook.

RIFF-39 proved pre-publication remote composition live. Publication and observer paths have deterministic local coverage; a credentialed end-to-end publication smoke proof remains pending. Completed planner-session continuation now has deterministic local coverage. Fix pass, poller reboot recovery, and general controller-owned external-only delivery remain absent.

## Non-goals for v1

No YAML or generic workflow DSL, user-defined workflows, plugins, inheritance, DAG, parallel writers, dynamic recipe registry or selector, report-only result, automatic merge, deployment, Temporal, dynamic swarm, or self-hosted sandbox fleet.
