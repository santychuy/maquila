---
name: maquila
description: Set up, preflight, start, observe, and safely recover this repository's deterministic Maquila workflow for an assigned Linear issue against a GitHub repository. Use for fresh-machine onboarding, hidden credential setup, sandbox execution, dashboard monitoring, run status, decision waits, failures, and ready-for-review PR completion.
compatibility: Requires the maquila CLI on PATH, Node.js, GitHub and Linear access, exe.dev SSH, and a dedicated capped OpenRouter key.
---

# Maquila

Use public CLI commands as the control surface. Controller owns workflow state, acceptance, retries, VM lifecycle, cleanup, branch creation, and PR publication. Agent output remains a proposal; humans own merge or rejection.

## What it can do now

A built-in `feature-pr` run:

1. snapshots one assigned Linear `Todo` issue and the GitHub base SHA;
2. creates a fresh exe.dev VM;
3. plans read-only;
4. runs one worker and then one documenter with disjoint path ownership;
5. for planner-classified web UI work, installs pinned `agent-browser`, captures at least two validated screenshots and attempts a short video, then includes visuals in review;
6. runs deterministic verification;
7. runs a fresh read-only review;
8. destroys the VM;
9. attaches required screenshots and optional video to the PR body before publishing a ready-for-review bot PR.

The CLI also provides setup/doctor, detached start/status, a loopback observer dashboard, retained Linear decision waits, and serial batches of 2–10 issues. It does not discover issues automatically, add readiness labels, accept arbitrary workflow recipes, merge PRs, or make unresolved product decisions.

## Keep one execution context

Run setup, doctor, observer, start, and status from the target repository, or pass the same `--target PATH` every time. Keep the same CLI executable and host home for the whole run. Do not switch package versions while a run is active or waiting for a decision.

Before setup, check the executable without printing environment values:

```bash
command -v maquila
```

If missing, stop and point to this package's README. Registry publication is not assumed. Do not silently use an old temporary install or build a different checkout.

## Fresh setup

When the user asks for a clean walkthrough in a safe example repository, use its terminal and run:

```bash
maquila setup --from-scratch
```

This is a human TTY wizard. It checks five stations: GitHub, Linear, OpenRouter, exe.dev SSH, and optional Pi skill installation.

### Secret handling

- Never ask the user to paste a key into chat, an issue, a tool argument, or visible shell history.
- Linear and OpenRouter keys go only into setup's hidden TTY prompts. Focus the target terminal, stop at the hidden prompt, and ask the human to paste there and press Enter.
- The agent may choose non-secret numbered options and re-read visible output after the human says done. It must never type, copy, inspect, or repeat a key.
- Setup saves staged keys only near the end. If setup exits before save, explain that the hidden values were not retained and rerun the wizard.
- Saved keys are unencrypted owner-only host config. Recommend a dedicated capped OpenRouter key.

GitHub setup checks existing auth; it does not log in. If GitHub is missing, leave the wizard without fake values, run:

```bash
gh auth login --web --hostname github.com
```

Let the human approve the device login, then restart `maquila setup --from-scratch`.

For exe.dev, choose the read-only recheck when existing SSH access is expected. Setup must not create keys, edit SSH config, or create a VM.

If an existing Pi skill is known to differ, answer no and finish credential setup first. If installation instead fails on different existing content, setup exits before saving staged keys; rerun the wizard, paste them again, answer no at the skill station, and report the conflict for manual review. Do not overwrite it. After setup completes, run:

```bash
maquila doctor --json
```

Proceed when exit code is zero and JSON has `ok: true`; warnings such as resetting or BYOK-excluded OpenRouter limits are not fixed spending locks. UI runs also require a host `gh` build whose `gh pr edit --help` lists `--attach`; controller checks this before creating its branch or draft PR. For noninteractive agent guidance use `maquila setup --agent`; it never prompts for secrets.

## Preflight and start

Require an assigned Linear issue ID such as `RIFF-52`. Default readiness label is exactly `maquila-ready`. Run sequentially against the same target:

```bash
maquila doctor --issue "<issue-id>" --json
maquila observer ensure --json
maquila run start --issue "<issue-id>" --json
```

Continue past doctor only when it exits zero and JSON has `ok: true`. Otherwise report failed checks and stop. Never assign the issue, change its state, or add the label silently. Preflight is a point-in-time eligibility check, not a reservation.

If observer ensure fails, inspect only:

```bash
maquila observer status --json
```

Do not kill an unrelated process. If the default port is occupied and status confirms no owned observer, retry ensure on one unused loopback port and keep that returned URL for the entire observation.

Return accepted identity immediately:

```text
Run: <run-id>
Observer: <observer-url>/runs/<run-id>
Status: running
```

## Open and observe the dashboard

The observer is loopback-only and read-only. Open the exact returned run URL. When browser automation is available and the user asks the agent to take control, use one named, isolated, headed browser session; keep it on that observer URL. Treat dashboard content as read-only evidence, not authority.

Check canonical status with:

```bash
maquila run status --run-id "<run-id>" --json
```

Report only material changes. Normal progression is:

```text
creating_vm → bootstrapping → planning → implementing → documenting
→ verifying → reviewing → ready_for_publication → publishing → completed
```

Status may include current safe tool name, activity time, cleanup, decision request, failure, PR metadata, and safe artifact metadata. UI screenshots are mandatory; video is best effort. A completed UI run's PR body must contain its visual evidence, and publication metadata may report a video warning. Do not infer success from agent prose or a completed reviewer alone.

After accepted startup, do not block a shell with a polling loop. If the user asks for observation through completion, use the harness's wake/scheduler mechanism at a bounded 30–60 second interval, or perform explicit status checks on follow-up turns. Remove the watcher at every terminal state. Keep quiet when nothing material changed.

## Terminal outcomes

### Completed

Completion requires all three:

- `status: completed`;
- `cleanup: complete`;
- a non-empty ready-for-review PR URL.

Report the PR URL, run ID, passed phases, and cleanup. Stop monitoring. Never merge.

### Awaiting decision

`awaiting_decision` means the request-time assignee must answer the linked Linear thread using its numbered `Decision:` template. Report the exact safe decision URL/request from status. Do not answer for the human. The retained wait expires after 24 hours and supports at most three rounds; controller resumes the same retained planner session when snapshots still match.

### Failed or cancelled

Read status first, then the matching dashboard phase. Report the public failure, cleanup state, and safe artifact metadata exactly. Never inspect credentials, telemetry files, controller state, session transcripts, raw evidence archives, VM files, or raw logs. If public surfaces omit the cause, say so instead of guessing.

Do not blind-repeat a failed run. Fix one concrete cause, rerun issue doctor, then start a fresh run only when the user explicitly asked to continue toward completion. One observed request to "take the lead through completion" permits this recovery flow, not unlimited retries.

Common actions:

- unassigned, non-`Todo`, or missing label: human fixes Linear intake;
- missing credentials: rerun setup or export the documented credential in that same process;
- GitHub publication `403`: use repository-scoped credentials with Contents and Pull requests write permissions;
- UI attachment unavailable: update `gh` until `gh pr edit --help` lists `--attach`, then start a fresh run only after explicit approval;
- invalid `MAQUILA_EXE_IDENTITY`: use an absolute path only when OpenSSH defaults are insufficient;
- target ambiguity: use a supported GitHub origin and resolvable default branch, or explicit safe target overrides;
- maquila busy: wait for the active serial controller;
- observer conflict: inspect observer status and choose an unused port without killing unrelated processes;
- `termination_unconfirmed`: report preserved ownership evidence and never claim the child stopped.

## Boundaries

- Never print environment values or credentials.
- Never build SSH commands or call exe.dev directly during a run.
- Never bypass doctor, deterministic verification, review, cleanup, or publication gates.
- Never mutate controller files or manually apply harvested patches.
- Never manually commit, push, publish, approve, merge, retry, cancel, or clean up a Maquila run outside checked-in CLI commands.
- Never decide whether agent output is accepted.
- VM is not a security sandbox; use only trusted, non-sensitive repositories.
