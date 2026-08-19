---
name: software-factory
description: Start and observe this repository's deterministic software-factory workflow for a Linear issue against an explicit target Git repository. Use whenever the user asks to run the factory, build a Linear issue in a sandbox, start an observed factory run, or check a factory run's live status.
compatibility: Requires this software-factory checkout, built CLI, Node.js, pnpm, exe.dev identity, and controller credentials.
---

# Software Factory

Route user intent through checked-in deterministic commands. Controller owns workflow state, acceptance, VM lifecycle, and cleanup; skill only starts or reads a run.

## Start a run

Require both:

- Linear issue identifier, such as `RIFF-52`
- absolute target Git repository path

Do not infer target from factory repository. If either value is missing, ask for it.

From factory repository root:

```bash
pnpm run build
pnpm run factory -- observer ensure --json
pnpm run factory -- run start --target "<absolute-target-path>" --issue "<issue-id>" --json
```

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
pnpm run factory -- run status --run-id "<run-id>" --json
```

Report status, phase, current safe tool name, last activity, cleanup, failure, pull-request metadata, and safe artifact metadata exactly as command returns. A later controller failure is run outcome, not skill execution failure. A completed run must include the ready-for-review pull-request URL.

## Safe failures

Explain only actionable public errors:

- missing `LINEAR_API_TOKEN` or `GITHUB_TOKEN`: configure required controller credentials
- GitHub publication `403`: use a fine-grained token for the target repository with Contents and Pull requests write permissions
- missing or invalid `FACTORY_EXE_IDENTITY`: configure absolute exe.dev identity path
- target ambiguity: provide supported GitHub origin and resolvable remote default branch, or explicit safe overrides
- factory busy: wait for active serial controller run
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
