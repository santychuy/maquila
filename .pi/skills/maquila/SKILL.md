---
name: maquila
description: Start and observe this repository's deterministic maquila workflow for a Linear issue against the current Git repository. Use whenever the user asks to run the maquila, build a Linear issue in a sandbox, start an observed maquila run, or check a maquila run's live status.
compatibility: Requires the maquila CLI on PATH, Node.js, controller credentials, and a configured OpenRouter key.
---

# Maquila

Route user intent through checked-in deterministic commands. Controller owns workflow state, acceptance, VM lifecycle, and cleanup; skill only starts or reads a run. Planner, worker, documenter, and reviewer use their per-agent authoritative pinned OpenRouter models. Model catalog is not bundled. Linear/GitHub credentials stay outside VM; dedicated capped OpenRouter key is transient VM exception. VM is not a security sandbox.

## Start a run

Require an assigned Linear issue identifier, such as `RIFF-52`, and an explicit repository target. This skill does not provide automatic intake. If either is missing, ask for it. Run the read-only eligibility preflight before starting.

```bash
maquila doctor --target "/absolute/path/to/repository" --issue "<issue-id>" --require-label "maquila-ready" --json
maquila observer ensure --json
maquila run start --issue "<issue-id>" --target "/absolute/path/to/repository" --json
```

Run these commands sequentially. Continue past doctor only when it exits zero and its JSON has `ok: true`. Otherwise report the failed checks and stop; do not start a run or silently add the label. Use the same explicit target for preflight and start. The preflight does not reserve an issue or enforce a controller-side trigger policy; automatic discovery and trigger enforcement are not implemented.

Read command JSON only. Return accepted run ID and observer URL:

```text
Run: <run-id>
Observer: <observer-url>/runs/<run-id>
Status: running
```

Do not wait for completion after accepted startup.

## Check a run

Use run ID returned by start:

```bash
maquila run status --run-id "<run-id>" --json
```

Report status, phase, current safe tool name, last activity, cleanup, decision request, failure, pull-request metadata, and safe artifact metadata exactly as command returns. `awaiting_decision` means the request-time assignee must reply to the linked Linear thread using its numbered `Decision:` template; the detached controller then resumes the same retained VM and completed planner session when input snapshots still match. The wait expires after 24 hours. A later controller failure is run outcome, not skill execution failure. A completed run must include the ready-for-review pull-request URL.

## Safe failures

Explain only actionable public errors:

- unassigned Linear issue: assign a responsible engineer before starting the run
- missing Linear, GitHub, or OpenRouter credentials: run `maquila doctor --target "/absolute/path/to/repository" --json` and configure `LINEAR_API_TOKEN`, `GITHUB_TOKEN`, or `OPENROUTER_API_KEY` (or setup an `op://` reference)
- GitHub publication `403`: use a fine-grained token for the target repository with Contents and Pull requests write permissions
- invalid `MAQUILA_EXE_IDENTITY`: configure an absolute exe.dev identity path only when OpenSSH defaults are insufficient
- target ambiguity: provide supported GitHub origin and resolvable remote default branch, or explicit safe overrides
- maquila busy: wait for active serial controller run
- observer port conflict/unhealthy process: inspect `observer status --json`; do not kill unrelated process
- `termination_unconfirmed`: report run ID and preserved ownership evidence; never claim child stopped

Never print environment values.

## Boundaries

- Never build SSH commands or call exe.dev directly.
- Never read credentials, telemetry files, controller state, session transcripts, or VM files.
- Never parse logs or inspect VM directly.
- Never launch, retry, cancel, approve, publish, merge, or clean up outside the checked-in controller commands.
- Never decide whether agent output is accepted.
- Never commit, push, publish, or merge.
