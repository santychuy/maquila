# Software Factory

Small internal software factory, built one proven slice at a time.

Current foundation loads validated specialist definitions, runs planner through Pi SDK, and validates typed role envelopes.

```bash
npm install
npm run build
npm run factory -- agents list
npm run factory -- pi plan \
  --repo /absolute/path/to/repository \
  --issue ./examples/issue.md \
  --model provider/model \
  --timeout-seconds 300
```

Evidence lands under `.factory/runs/<run-id>/`:

- `issue.md`: snapshotted input
- `events.jsonl`: concise Pi lifecycle events
- `plan.md`: planner output, present only for completed runs
- `receipt.json`: issue hash, base SHA, model, session, usage, cost, status

Agent definitions live in `agents/*.md`: YAML frontmatter holds metadata, access class, and tool allowlist; Markdown body is system prompt. Shape is inspired by pi-subagents, with stricter factory validation. Standalone YAML and TOML are not used.

Defined roles:

- `planner`: read-only repository planning
- `worker`: sole writer with shell and file mutation tools
- `reviewer`: fresh, read-only independent review

Only planner is wired to executable step today. Model must already have authentication available to Pi.

Current timeout is cooperative through Pi SDK. Future controller will enforce hard wall time by terminating VM. Read-only tools prevent mutation, not reads outside repository or source disclosure to model provider. Use only trusted, non-sensitive repositories until sandbox boundary exists.

Evidence root is `.factory/` under directory where command runs.

See [ARCHITECTURE.md](ARCHITECTURE.md) for full blueprint and build order, [docs/envelopes.md](docs/envelopes.md) for the envelope model, and [docs/foundation-checkpoint.md](docs/foundation-checkpoint.md) for a verified snapshot of what exists today.
