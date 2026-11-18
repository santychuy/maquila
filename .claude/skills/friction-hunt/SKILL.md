---
name: friction-hunt
description: Finds and removes frictions in the Maquila experience after or during an end-to-end run of the setup skill or a factory job. A friction is any moment a human had to step in, wait, retry, copy-paste or clean up, any step that failed or needed a nudge, and any leftover panes, files, branches, VMs, deploy keys or edits to the user's repo. Use for "find frictions", "what slowed us down", "retro", "where did I have to step in", "blockers", "make setup smoother", "leave everything clean", or after a dogfood run or a finished job such as RIFF-68. Flags each friction, finds the root cause, proposes the smallest fix, and logs it in docs/frictions.md.
license: MIT
metadata:
  homepage: https://github.com/santychuy/maquila
---

# Friction hunt

Goal: an agent-led setup and factory where the human steps in only when truly required. Every extra human touch is a friction; find it, trace it to its cause, shrink it, and prove the fix.

## 1. Gather evidence

Start with the run's conversation/transcript, then check the live state. Read [references/evidence.md](references/evidence.md) for the exact commands (multiplexer panes, factory over ssh, GitHub, Linear, exe.dev, the user's working tree). Skip sources the run never touched.

## 2. Rebuild the timeline

One row per step: step, actor (agent or human), duration, outcome. Gaps and long waits show up here, so build it before judging anything.

## 3. Flag frictions

Raise a flag for each of:

- the human had to step in, wait, retry, copy-paste, or clean up
- a step failed or needed a nudge (e.g. the agent ended its turn too early)
- confusing output, or missing visibility (the user could not tell what happened)
- state left behind: panes/tabs, temp files, branches, VMs, deploy keys, edits to the user's repo

## 4. Classify

- **removable**: an agent could do it. Fix it.
- **necessary-human**: by design (typing secrets, OAuth sign-in, signup, merging PRs). Do not remove; make it short, clearly flagged, and say exactly what to do.
- **external**: a third-party limitation. Document it and work around it if cheap.

## 5. Root cause and smallest fix

Name where the cause lives: setup skill text, `scripts/*.sh`, `app/` code, docs, or an external service. Propose the smallest change that removes it (prefer deleting or tightening text over adding code) and rate impact high/med/low. Fixing the cause once beats patching symptoms.

## 6. Purification check

List every leftover from the evidence. Clean what the agent created. Ask before touching anything the user may own. The user's original panes and working tree must end as they started.

## 7. Verify

After a fix lands, re-run only the affected step. Mark `verified` only with evidence (output, pane capture, API response); a fix without a re-run stays `fixed`.

## Output

A ranked table (highest impact first), then what the human must know:

```
| # | Friction | Evidence | Class | Root cause | Fix | Impact | Status |
|---|----------|----------|-------|------------|-----|--------|--------|

Human needs to know
- <step the human must do or be aware of, and why>
```

Then append one row per friction to `docs/frictions.md` (ledger columns: date, run, friction, class, fix, status `open` / `fixed` / `verified` / `accepted`). Update existing rows rather than duplicating them.

## Example

Evidence: after `secrets.sh` the transcript shows the user asking "did it save?" and the pane gone.
- Friction: the secrets pane closed on exit, losing the ✓/✗ lines.
- Class: removable. Root cause: setup skill text opened a non-interactive pane.
- Fix: open an interactive shell pane and keep it open until the agent has read the result. Impact: medium. Status: `fixed`, to be `verified` on the next setup run.
- Human needs to know: typing the secrets in that pane is by design.
