# Foundation checkpoint

Verified snapshot of this repository, recorded 2026-08-17. This page describes
implemented behavior, recorded evidence, and the next build step. See
[ARCHITECTURE.md](../ARCHITECTURE.md) for the target controller and build order.

## Current boundary

Build-order steps 1 and 2 exist:

1. validated agent definitions;
2. one executable planner step through the Pi SDK.

Worker and reviewer definitions exist, but no code runs them. No controller,
VM, verification gate, intake, or publication flow exists yet.

## Implemented primitives

- `src/agents.ts` loads `agents/*.md`, parses Markdown with YAML frontmatter,
  validates definitions, and exposes `listAgents()`, `loadAgent()`, and
  `loadAgentFile()`.
- `src/plan.ts` exposes `runPlan(options)`, the only executable agent step. It
  validates the Git repository and issue file, loads the planner, creates an
  isolated Pi `AgentSession`, applies a cooperative timeout, captures events,
  and writes a receipt. `MAX_TIMEOUT_SECONDS` is `1800`.
- `src/run-artifacts.ts` creates `.factory/runs/<run-id>/` below the command's
  current working directory, snapshots the issue, appends JSONL events, and
  atomically writes JSON files through a temporary file and rename.
- `src/cli.ts` provides `agents list` and `pi plan`. Exit codes are `0` for
  completion, `1` for failure or usage error, and `124` for timeout.

## Agent format and validation

Each agent is one Markdown file. YAML frontmatter stores metadata and policy;
the Markdown body is its system prompt. Standalone YAML and TOML are not used.

Allowed fields: `name`, `description`, `tools`, `thinking`, and `access`.
`tools` must be a non-empty, duplicate-free list from `read`, `grep`, `find`,
`ls`, `bash`, `edit`, and `write`. `thinking` defaults to `medium` and must be
one of the supported Pi levels. `access` is `read-only` or `writer`.

Validation fails closed: unknown fields, malformed values, filename/name
mismatches, empty prompts, duplicate agent names, read-only mutation tools
(`bash`, `edit`, `write`), and writers without a mutation tool are rejected.

## Role contracts

| Role | Access and tools | Prompt output |
| --- | --- | --- |
| `planner` | read-only: `read`, `grep`, `find`, `ls` | `Summary`, `Evidence`, `Changes`, `Verification`, `Risks`, `Decisions Needed` |
| `worker` | writer: planner tools plus `bash`, `edit`, `write` | `Implemented`, `Changed Files`, `Validation`, `Open Risks` |
| `reviewer` | read-only: `read`, `grep`, `find`, `ls` | `Verdict` (`PASS`/`FAIL`), `Correct`, `Blocking Findings`, `Non-blocking Findings`, `Residual Risks` |

Planner must plan from repository evidence without edits or invented behavior.
Worker is sole writer and must not commit, push, publish, or merge. Reviewer
uses a fresh session, checks code and evidence independently, and cannot return
`PASS` with blocking findings.

## CLI and evidence

Build first, then run:

```bash
npm run build
npm run factory -- agents list
npm run factory -- pi plan \
  --repo /absolute/path/to/repository \
  --issue ./examples/issue.md \
  --model provider/model \
  --timeout-seconds 300
```

`pi plan` requires `--repo`, `--issue`, and `--model`; timeout defaults to 300
seconds and accepts integers from 1 through 1800. The repository must be a Git
work tree and the issue must be a file. Pi must already have model
authentication configured.

Each run writes:

- `issue.md`: input snapshot;
- `events.jsonl`: concise lifecycle, tool, usage, retry, deadline, and settle events;
- `plan.md`: final planner text, only when status is `completed`;
- `receipt.json`: status, timestamps, repository/base SHA and dirty state, issue
  hash, model, timeout, resolved agent metadata, session, usage/cost, and artifacts;
- `sessions/`: full Pi session transcript.

Evidence root is `.factory/` under the command's current working directory,
not necessarily under the target repository.

Recorded evidence contains five runs against this repository using
`examples/issue.md` and `openai-codex/gpt-5.6-sol:medium`: one completed run
(the 120-second run, 20 tool calls, 24,458 total tokens, cost about $0.164)
and four deliberate one-second timeouts. Historical receipts differ in schema: completed receipt `4efb4327` lacks agent
metadata; completed receipt `374ee249` includes agent metadata but no access
field; completed receipt `63e1aeb1` has the current full shape. Receipt
`012e868e-7a1f-4ee6-8da3-3748384f1973` lists `plan.md` although no such file was
written; current code lists it only for completed runs. Recorded runs
also show this checkout was dirty, so they are execution evidence, not clean
baseline proof.

## Tests

`npm test` builds and runs four Node tests in `test/cli.test.ts`:
required CLI input and safe timeout, timeout ceiling and missing input,
all role boundaries, and fail-closed schema/access validation.
`npm run check` adds TypeScript no-emit checking.

## Security limits

- Definition loading blocks read-only mutation tools; planner resources load no
  extensions, skills, prompts, themes, or `AGENTS` files.
- Timeout calls `session.abort()` and records `deadline_reached`; it is
  cooperative, not an OS-enforced wall. A hung SDK call can survive it.
- Read-only tools do not stop reads outside the repository, and repository
  source is sent to the model provider. Use trusted, non-sensitive repositories
  until a sandbox boundary exists.
- No VM/sandbox isolation, credential separation, or network policy exists.

## Deferred work

Architecture steps 3–8 remain deferred: worker/reviewer execution; deterministic
verification and exact diff gates; controller state with SQLite, budgets,
idempotency, and recovery; exe.dev VM lifecycle; Linear intake; and GitHub
publication. v1 also excludes generic workflow DSL, dynamic swarm, multiple
writers, automatic merge, deployment, visualizer, Temporal, and a self-hosted
sandbox fleet.

## Exact next primitive

Build-order step 3: **Pi worker and reviewer execution**. Wire existing worker
and reviewer definitions to executable steps, preserving the worker sole-writer
policy, fresh review context, and typed outputs; add the write and review gates
before running them.
