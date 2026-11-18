# Frictions ledger

Maintained by the `friction-hunt` skill. Status: `open`, `fixed` (change landed), `verified` (re-run with evidence), `accepted` (known, deliberately not fixed).
Class: removable, necessary-human, external.

| Date | Run | Friction | Class | Fix | Status |
|---|---|---|---|---|---|
| 2026-11-18 | setup dogfood | Claude Code `!` can't read hidden input, so the secrets prompt needs a real terminal | removable | Skill pane rule | verified |
| 2026-11-18 | setup dogfood | Setup agent ended its turn while the secrets pane was open and needed a nudge | removable | Skill waits in-turn (9aaba92) | fixed |
| 2026-11-18 | setup dogfood | Secrets pane closed on exit, losing the ✓/✗ lines | removable | Interactive pane kept open until read (9aaba92) | fixed |
| 2026-11-18 | setup dogfood | Agent added Linear MCP to the user's committed `.mcp.json` and needed a session restart | removable | Ask first, `--scope local` (skill) | fixed |
| 2026-11-18 | setup dogfood | Orchestrator ran `npx skills add` in the user's own pane and left output/panes behind | removable | Dedicated labelled panes, closed at end; skill rule added | open |
| 2026-11-18 | factory job | `git pull --ff-only` before jobs failed on a deleted job branch | removable | Fetch-only sync (8e56b73) | fixed |
| 2026-11-18 | factory job | Factory PRs and Linear comments appear as the user | removable | Bot identity: GitHub App + Linear app (low priority) | open |
| 2026-11-18 | factory job | First job on a fresh VM installs the toolchain (bun) itself | removable | None: one-time per VM; revisit if a job fails on a missing toolchain | accepted |
| 2026-11-18 | setup dogfood | Secrets first collected via a local `.env` the user had to create | removable | Masked prompt in setup + Settings → Secrets | verified |
