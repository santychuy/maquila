# Foundation checkpoint

Verified snapshot updated 2026-08-21. This page describes current code and evidence. See [ARCHITECTURE.md](../ARCHITECTURE.md), [envelopes](envelopes.md), and [local observer](observer.md).

## Current boundary

Milestones through remote controller composition are complete:

- **3A runner:** generic `runAgent()` owns one bounded Pi session, isolated resources, events, receipts, artifacts, and cooperative timeout handling.
- **3B envelope kernel:** typed planner, worker, documenter, and reviewer schemas; structural and semantic validation; `submit_envelope`; one same-session correction; accepted envelope and receipt evidence.
- **Verification gate:** `src/verify.ts` fail-closed parses `factory.verify.json`, runs argv commands serially with `execFile` semantics, and applies an exact Git diff gate. Structured results provide consistency evidence, not authenticity against a process with VM OS access.

All four role schemas run locally and through `factory run` in a fresh exe.dev VM. Worker owns approved non-doc paths, then documenter owns approved docs paths; docs-only runs skip worker. Verification and reviewer inspect aggregate diff. The controller snapshots immutable intake, serializes execution with a local lock, reconciles abandoned controller VMs, bootstraps pinned Node and target runtimes, invokes planner/worker/documenter/reviewer sessions, checks structural links among deterministic and review evidence, binds the reviewed diff to the harvested patch, and destroys the VM. The trusted controller then verifies the pinned base in a temporary clone, applies the reviewed patch, creates a deterministic commit and branch, and opens a ready-for-review pull request before reporting `completed`. GitHub write credentials never enter the VM. OpenRouter uses a dedicated capped key as deliberate transient exception: controller creates mode-`0600` VM-local Pi provider config for agent calls, best-effort removes it before VM destruction, and tells user to revoke key if cleanup fails. These checks detect inconsistency but are not cryptographic authenticity because VM agents retain OS-level access; VM is not a security sandbox.

## Implemented primitives

- `src/agents/index.ts` loads and fail-closed validates Markdown agent definitions, including authoritative pinned OpenRouter model fields. Current role defaults are Gemini 3.7 Flash for documenter/reviewer, GLM 5.3 for planner, and Grok 4.6 for worker; no complete model catalog is bundled, so doctor and remote bootstrap validate against OpenRouter's live catalog. Agent requests cap maximum output at 16,384 tokens.
- `src/run-agent.ts` exposes generic `runAgent()` and records session, lifecycle events, receipt, timeout, and envelope results.
- `src/envelope.ts` defines role schemas, `parseEnvelope()`, correction prompt, submit tool, and planner rendering.
- `src/workflows/plan.ts` exposes the executable planner path and writes `plan.md` from its accepted planner envelope.
- `src/run-artifacts.ts` creates `.factory/runs/<run-id>/`, snapshots input, appends JSONL events, and writes JSON artifacts.
- `src/verify.ts` loads `factory.verify.json`, executes repository checks, and evaluates the exact Git diff gate.
- `src/workflows/worker.ts` runs sequential disjoint worker/documenter writers, deterministic verification, and a separate reviewer with aggregate lifecycle evidence.
- `src/integrations/linear.ts`, `src/integrations/github.ts`, and `src/intake.ts` validate and hash immutable external inputs; Linear intake requires an assignee, can create an assignee-mentioned decision thread, and accepts only current-assignee replies beginning with `Decision:`; `src/integrations/github.ts` publishes an idempotent controller-side branch and ready-for-review pull request without storing credentials.
- `src/run-state.ts` atomically stores fail-closed controller state with transition validation, idempotency checks, and orphan VM lookup.
- `src/integrations/exe.ts` provides tested command construction for exe.dev SSH, SCP, and retryable deletion without retaining credentials. Integration boundaries live together under `src/integrations/`.
- `src/controller-lock.ts`, `src/controller.ts`, and `src/controller-chain.ts` provide single-host ownership, restart cleanup, remote bootstrap/lifecycle, fail-closed evidence harvest, unconditional cleanup, bounded decision-thread polling, and fresh linked continuation runs.
- `src/telemetry.ts` adds a strict append-only host event ledger with gap-free sequencing, safe replay, bounded public fields, and terminal cleanup reconciliation.
- `src/remote-protocol.ts` plus streaming exe.dev SSH expose deterministic live phase, agent/tool, gate, and review activity without prompts, tool arguments/results, or raw output. Controller code still owns state transitions and acceptance.
- `src/target.ts`, `src/run-launcher.ts`, and `src/run-status.ts` add target-repository inference, accepted detached controller startup with a preallocated run ID, and read-only telemetry status folding.
- `src/observer.ts`, `src/observer-ui.ts`, and Preact components in `src/observer-app.tsx` add a managed loopback-only GET/HEAD server, ownership-checked process lifecycle, replay/cursor API, and accessible polling UI bundled into the binary.
- `.pi/skills/software-factory/SKILL.md` provides a thin factory-owned Pi command router for observed start and status flows.

## Evidence

Live controller run `fa7b5de1-8125-469f-b723-5db21243d783` completed RIFF-39 against Bookbounce SHA `04c6e9a5efa53727f2f0959e0e6ca4a3639b38c7`. Planner, worker, and fresh reviewer receipts and transcripts were harvested; `bun run validate` passed with 130 tests passed, one integration test skipped, and zero failures; the exact Git gate allowed only the planned assessment artifact; reviewer verdict was `PASS`; cleanup was recorded complete; exe.dev listed zero VMs; controller evidence contained neither controller token. No Bookbounce commit, branch, push, or PR was created. Generated `.factory/` evidence remains ignored by Git.

Telemetry/streaming, detached launcher, local observer server/UI, factory-owned Pi skill, and GitHub publication are implemented and covered by deterministic local tests. Publication has not yet completed a credentialed end-to-end smoke run, so the RIFF-39 evidence above proves the earlier controller path only.

## Controller limitations

The lock and recovery model is single-host and serial. A timed-out SSH command may continue remotely until VM destruction succeeds; cleanup cannot be guaranteed while exe.dev control-plane deletion is unavailable. The controller starts a fresh linked run after an assigned engineer decision rather than resuming an in-flight agent session. Its local poller requires the detached controller process to remain alive; no hosted webhook or reboot recovery exists yet. Publication fails closed if the target base branch moves after intake or if a deterministic factory branch already contains different content. Successful publication still requires a non-empty repository diff; only unresolved engineer decisions currently have a Linear delivery contract. Agents still have OS-level access inside the VM; use trusted, non-sensitive repositories.

## CLI architecture decision

The CLI is split into small, zero-dependency modules under `src/cli/`: `types.ts` holds command/result types, `helpers.ts` shared validation and output helpers, `parse.ts` dispatches, `commands/agents.ts`, `commands/setup-doctor.ts`, `commands/observer.ts`, `commands/run.ts`, and `commands/pi.ts` parse command families, and `index.ts` owns execution and process boundaries. This keeps command parsing separate from side effects while preserving current nested commands.

The architecture council compared Node's built-in `node:util.parseArgs`, Commander, and CAC. It chose `parseArgs` plus a static TypeScript dispatcher: no new dependency, `trustedDependencies` stays empty, and Bun compilation remains direct. CAC was rejected because it does not provide the nested subcommand support required here. Commander was not selected because a framework adds dependency and abstraction cost that this modular command layout does not need.

## Factory DX

Build and link the current-platform standalone executable with `bun run build` then `bun link`. Commands target current working directory by default; `--target PATH` overrides it. Human output is default; `--json` is machine mode. The global command stays linked to the checkout because runtime agent definitions, skill files, and the source archive remain repository-owned. `bun run build:binary` rebuilds only `dist/factory`; check `test -x ./dist/factory` before linking, or run `factory doctor`, which reports a missing binary and its `bun run build` remedy.

`dist/factory` is a Bun-compiled native executable for the OS and CPU where it was built. Do not copy one platform's binary to another. During `factory run`, the controller copies the checkout to the exe.dev VM, runs `bun install --frozen-lockfile`, builds there with Bun, then runs that VM-local `dist/factory` for planning, worker, verification, and review. The host's linked command is not the remote runtime.

`factory setup` writes strict mode-`0600` config under `$XDG_CONFIG_HOME/factory/config.json` or `~/.config/factory/config.json`. It may store optional Linear and OpenRouter `op://Vault/Item/field` references and may install user-scope Pi skill with `--install-skill`. `factory doctor` checks config, target, credentials, SSH, built CLI, and skill, and reports remediation.

GitHub credential precedence: `GITHUB_TOKEN`, `GH_TOKEN`, `gh auth token`. Linear precedence: `LINEAR_API_TOKEN`, configured `op read` reference. OpenRouter precedence: `OPENROUTER_API_KEY`, configured `op read` reference. `factory setup --openrouter-token-reference op://Vault/Item/field` stores only reference; `factory doctor` checks resolution. exe.dev identity is optional through `--identity` or `FACTORY_EXE_IDENTITY`; OpenSSH config and agent are supported, `SSH_AUTH_SOCK` is host-only, and SSH uses `ForwardAgent=no`. Linear and GitHub credentials remain controller-side; target repository and VM stay free of those credentials. OpenRouter key is transient VM exception and must be dedicated/capped; VM is not a security sandbox. Runtime state remains under Factory checkout. No Linear OAuth, native keychain, or profiles exist.

## Local tooling

This repository uses Bun `1.3.14`, pinned by `package.json` and recorded in `bun.lock`. Use `bun install --frozen-lockfile`. Do not restore npm or pnpm lockfiles.

`bun run check` is the full local gate: type-aware Oxlint, Oxfmt verification, TypeScript checking, compiled Node tests, standalone binary compilation, and a read-only `--help` smoke check. Oxlint enables correctness and suspicious rules with TypeScript, Oxc, Unicorn, import, Node, and Promise plugins. Tests turn off only `typescript/no-floating-promises` and `typescript/no-unsafe-type-assertion`; this keeps the type-aware policy balanced for test code without disabling the broader checks. Oxfmt uses its defaults; `bun run format` writes them and `bun run format:check` verifies them.

Husky is local only: pre-commit runs `bunx lint-staged`, and pre-push runs `bun run check`. lint-staged runs `oxlint --fix` then Oxfmt on staged TypeScript and JavaScript files, and Oxfmt on staged JSON, Markdown, and YAML files. It preserves unstaged work while handling partial staging, and only its staged-file results enter the commit. Run the full gate before relying on these hooks.

An empty `trustedDependencies` list keeps dependency lifecycle scripts blocked unless explicitly reviewed and approved. There is no hosted CI workflow: checks run locally through these commands and hooks.

## Tests

The verified DX checkpoint passes 196 tests (`bun run check`). This count records this checkpoint; it is not an evergreen promise.

`bun run test` covers role boundaries, envelopes, local worker/reviewer lifecycle failures, controller lock/recovery and fake remote lifecycle paths, tar and patch trust boundaries, artifact safety, verification and Git gates, Linear/GitHub input validation and publication, credential redaction, deterministic intake and publication identities, detached startup, telemetry replay, observer ownership, read-only HTTP boundaries, UI routes, and skill wiring.

## Failure and security limits

Bounded remote lifecycle errors are redacted and copied into controller receipts and public failure telemetry when available; full transcripts remain in failure evidence. Agent timeout is cooperative: the runner calls `session.abort()` and records `deadline_reached`. The controller then destroys its VM, which is the hard cancellation boundary when exe.dev deletion is available. Read-only tools do not prevent reads outside the repository, and source is sent to the configured model provider. VM isolation keeps Linear and GitHub write credentials controller-side, but no restrictive in-VM network or filesystem sandbox exists.

## Next

Run one credentialed end-to-end publication smoke test and one assigned-engineer decision continuation smoke test. Then define the broader planning-output/delivery contract. Fix pass, hosted decision delivery, poller reboot recovery, and in-flight session resume remain out of scope.
