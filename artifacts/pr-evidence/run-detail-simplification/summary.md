# Run detail simplification evidence

## Validated behavior

The local observer now prioritizes phase status, elapsed time, compact tokens, reported cost, Agent/Code ownership, and role context while keeping exact metadata and system prompts behind disclosures. Repeated tool calls are grouped, and published runs expose an accessible GitHub PR link.

## Target

- Web UI: local Software Factory observer run detail
- Desktop viewport: 1280 × 900
- Narrow viewport: 430 × 900
- Demo data: generated local telemetry fixture; no production or customer data

## Validation

1. Opened a completed worker phase containing repeated tool calls, token usage, reported cost, and PR metadata.
2. Confirmed phase selector shows status once and compact `15K` token total.
3. Expanded exact phase metadata.
4. Expanded the system prompt and observed successful pinned-commit/hash-verified retrieval.
5. Confirmed grouped tool activity, including prior error state.
6. Repeated layout check at 430 px width.
7. Ran axe WCAG 2 A/AA checks at desktop and narrow widths: zero violations and zero incomplete checks.
8. Checked browser errors: none.
9. Ran `bun run check`: 185 tests passed, lint/format/typecheck/bundle/binary smoke gates passed.

## Artifacts

- `demo.mp4` — short H.264 walkthrough
- `preview.gif` — compact fallback preview
- `screenshots/desktop.png` — completed phase overview
- `screenshots/mobile-430.png` — narrow layout with disclosures open

## Limits

This validates the changed observer flow against deterministic local fixture data. It does not exercise a credentialed exe.dev run or verify provider billing. Reported cost remains informational Pi session telemetry.
