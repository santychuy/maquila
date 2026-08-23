# Foundation checkpoint

Verified snapshot updated 2026-08-21. Runtime implementation covers M1–M5; M6 completes its documentation. This page describes current code and deterministic evidence. See [architecture](../ARCHITECTURE.md), [workflows](workflows.md), [envelopes](envelopes.md), and [local observer](observer.md).

## Current boundary

Implemented foundation through M1–M5:

- Generic `runAgent()` owns one bounded Pi session, isolated resources, events, receipts, artifacts, and cooperative timeout handling.
- Typed planner, worker, documenter, and reviewer envelopes fail closed on invalid claims.
- `feature-pr` is one code-owned recipe. Accepted plan resolves approved paths and generates strict version-2 `workflow-manifest.json` bound to recipe definition, planner run, base SHA, explicit agent/code actor kinds, and the verifier's command-backed code definition.
- Serial block executor runs implement (or trusted docs-only skip), document, deterministic verify, and fresh review. The verifier is a code actor that runs manifest-pinned `bun run check` plus the exact Git gate. Successful result writes version-1 `workflow-execution.json` bound to manifest and reviewed patch.
- Remote protocol v2 carries canonical step identity. New controller state v2 records recipe, pinned manifest hash, current step, and attempt; state v1 remains readable and resumable for retained decision waits.
- Host telemetry, `run status`, and observer preserve current workflow checkpoint. Observer remains read-only.

All four role schemas run locally and through `maquila run` in a fresh exe.dev VM. Worker owns approved non-doc paths, then documenter owns approved docs paths. Verification and reviewer inspect aggregate diff. Verification is deterministic code, so execution record may link verify to primary writer run rather than inventing verifier session. Controller creates canonical host manifest, copies it into VM, validates remote serial sequence, checks manifest/execution/receipt/envelope/verification/review links, binds reviewed diff to harvested patch, and destroys VM. Trusted controller then verifies pinned base in temporary clone, applies reviewed patch, creates deterministic commit and branch, and opens ready-for-review pull request before reporting `completed`.

GitHub write credentials never enter VM. OpenRouter uses dedicated capped key as transient exception. Consistency checks are deterministic but not cryptographic authenticity: VM processes retain OS-level access and could forge consistent evidence. VM is not security sandbox.

## Implemented primitives

- `src/agents/index.ts` loads and fail-closed validates Markdown agent definitions, including authoritative pinned OpenRouter model fields. Current role defaults are `openrouter/google/gemini-3.7-flash` for worker/documenter/reviewer and `openrouter/z-ai/glm-5.3` for planner; no complete model catalog is bundled, so doctor and remote bootstrap validate against OpenRouter's live catalog. Agent requests cap maximum output at 16,384 tokens.
- `src/run-agent.ts` exposes generic `runAgent()` and records session, lifecycle events, receipt, timeout, and envelope results.
- `src/envelope.ts` defines role schemas, `parseEnvelope()`, correction prompt, submit tool, and planner rendering.
- `src/workflows/plan.ts` exposes executable planner path and writes `plan.md` from accepted planner envelope.
- `src/workflow-step.ts` defines canonical step, actor, and phase identity.
- `src/workflows/feature-pr.ts`, `manifest.ts`, and `execution.ts` define current recipe, strict manifest, definition/manifest hashes, completed run links, and reviewed-patch binding.
- `src/run-artifacts.ts` creates `.maquila/runs/<run-id>/`, snapshots input, appends JSONL events, and writes JSON artifacts.
- `src/verify.ts` executes manifest-pinned repository checks and evaluates the exact Git diff gate.
- `src/workflows/worker.ts` runs sequential disjoint worker/documenter writers, deterministic verification, and a separate reviewer with aggregate lifecycle evidence.
- `src/integrations/linear.ts`, `src/integrations/github.ts`, and `src/intake.ts` validate and hash immutable external inputs. Linear intake requires an assignee. A decision request pins that assignee, issue, round, question hash, and request time; only a later numbered `Decision:` reply from that pinned assignee is eligible. `src/integrations/github.ts` publishes an idempotent controller-side branch and ready-for-review pull request without storing credentials.
- `src/run-state.ts` atomically stores fail-closed controller state. New runs use v2 `executing` state plus workflow cursor; readers and decision resume retain v1 compatibility.
- `src/integrations/exe.ts` provides tested command construction for exe.dev SSH, SCP, and retryable deletion without retaining credentials. Integration boundaries live together under `src/integrations/`.
- `src/controller-lock.ts`, `src/controller.ts`, and `src/controller-chain.ts` provide single-host ownership, restart cleanup, remote bootstrap/lifecycle, fail-closed evidence harvest, bounded decision-thread polling, and same-run planner-session continuation on a retained VM.
- `src/telemetry.ts` adds a strict append-only host event ledger with gap-free sequencing, safe replay, bounded public fields, and terminal cleanup reconciliation.
- `src/remote-protocol.ts` protocol v2 plus streaming exe.dev SSH expose step-tagged phase, agent/tool, gate, and review activity without prompts, tool arguments/results, or raw output. Mixed binaries and mismatched step/actor/phase identity fail closed. Controller still owns state and acceptance.
- `src/target.ts`, `src/run-launcher.ts`, and `src/run-status.ts` add target-repository inference, accepted detached controller startup with a preallocated run ID, and read-only telemetry status folding.
- `src/observer.ts`, `src/observer-ui.ts`, and Preact components in `src/observer-app.tsx` add a managed loopback-only GET/HEAD server, ownership-checked process lifecycle, replay/cursor API, and accessible polling UI bundled into the binary.
- `.pi/skills/maquila/SKILL.md` provides a thin maquila-owned Pi command router for observed start and status flows.

## Evidence

Latest guided-setup checkpoint verification: `bun run check` passed with 247 tests; final independent review verdict was `PASS`. This is local deterministic evidence, not live credentialed end-to-end proof for setup, publication, or vendor access.

Live controller run `fa7b5de1-8125-469f-b723-5db21243d783` completed RIFF-39 against Bookbounce SHA `04c6e9a5efa53727f2f0959e0e6ca4a3639b38c7`. Planner, worker, and fresh reviewer receipts and transcripts were harvested; `bun run validate` passed with 130 tests passed, one integration test skipped, and zero failures; the exact Git gate allowed only the planned assessment artifact; reviewer verdict was `PASS`; cleanup was recorded complete; exe.dev listed zero VMs; controller evidence contained neither controller token. No Bookbounce commit, branch, push, or PR was created. Generated `.maquila/` evidence remains ignored by Git.

Telemetry/streaming, detached launcher, local observer server/UI, maquila-owned Pi skill, and GitHub publication are implemented and covered by deterministic local tests. Publication has not yet completed a credentialed end-to-end smoke run, so the RIFF-39 evidence above proves the earlier controller path only.

## Engineer decision flow

A planner can finish a Pi turn with unresolved questions. Maquila then pauses that controller run; it does not keep a model request open and does not create a linked run. It retains the VM and copies the completed planner session to a mode-`0600` host checkpoint. The checkpoint is limited to 8 MiB, pinned by SHA-256, and rejected if it contains the OpenRouter key. Maquila removes VM-local model credentials before waiting.

Maquila posts one marked Linear thread for the round. Retry lookup reuses that marked thread; duplicate matches or an ambiguous mutation result fail closed instead of posting another prompt. Request identity includes the issue, request-time assignee, round, question hash, count, and timestamp. Reply in that thread with every answer numbered:

```text
Decision:
1. <answer>
2. <answer>
```

Only a reply after the request time from the pinned assignee is accepted. Maquila polls every 30 seconds while detached. Check progress with `maquila run status --run-id <run-id>`. If the detached process stops, continue the persisted wait with `maquila run resume --run-id <run-id>`; an exclusive host lease and state checks prevent two resumptions from accepting the same reply.

Before accepting a reply, Maquila checks the 24-hour expiry and snapshots Linear issue and GitHub base again. Changed issue input, repository identity, or base SHA fails the run. It also checks the retained workspace and Maquila runtime before putting the OpenRouter config back. The same controller run then opens the completed Pi session checkpoint and starts the next planner turn. Deterministic verification, fresh review, cleanup, and publication remain unchanged.

A missing retained VM gets one replacement attempt. Maquila rebuilds the pinned workspace from controller state and restores the bounded checkpoint; another loss fails. Each wait lasts at most 24 hours, and one run allows at most three decision rounds. Expiry records `cancelled`, emits terminal telemetry, and attempts VM cleanup. Observer and `run status` keep an open wait as `awaiting_decision` rather than stale activity, and drop the live decision prompt once that wait phase finishes.

## Controller limitations

The lock and recovery model is single-host and serial. Resume survives a controller-process restart because wait state and planner checkpoint live on the host, but there is no hosted webhook or OS boot service to launch polling after a host reboot. Resume continues only at a completed Pi-turn boundary; an interrupted model request cannot continue. A timed-out SSH command may continue remotely until VM destruction succeeds, and cleanup cannot be guaranteed while exe.dev control-plane deletion is unavailable. Publication fails closed if the target base branch moves after intake or if a deterministic maquila branch already contains different content. Successful publication still requires a non-empty repository diff; only unresolved engineer decisions currently have a Linear delivery contract. Agents still have OS-level access inside the VM; use trusted, non-sensitive repositories.

## CLI architecture decision

The CLI is split into small, zero-dependency modules under `src/cli/`: `types.ts` holds command/result types, `helpers.ts` shared validation and output helpers, `parse.ts` dispatches, `commands/agents.ts`, `commands/setup-doctor.ts`, `commands/observer.ts`, `commands/run.ts`, and `commands/pi.ts` parse command families, and `index.ts` owns execution and process boundaries. This keeps command parsing separate from side effects while preserving current nested commands.

The architecture council compared Node's built-in `node:util.parseArgs`, Commander, and CAC. It chose `parseArgs` plus a static TypeScript dispatcher: no new dependency, `trustedDependencies` stays empty, and Bun compilation remains direct. CAC was rejected because it does not provide the nested subcommand support required here. Commander was not selected because a framework adds dependency and abstraction cost that this modular command layout does not need.

## Guided setup checkpoint

Guided setup is primary onboarding. From target repository, run `maquila setup`; use `--target PATH` when current directory is not target. `--identity /absolute/key` selects exe.dev SSH identity; `MAQUILA_EXE_IDENTITY` is fallback. Human TTY setup prints direct official links for [GitHub tokens](https://github.com/settings/personal-access-tokens/new), [Linear API keys](https://linear.app/settings/api), [OpenRouter keys](https://openrouter.ai/settings/keys), and [1Password CLI](https://developer.1password.com/docs/cli/get-started/). It accepts only validated `op://Vault/Item/field` references or environment-provided credentials. It never accepts raw secrets, opens browsers, automates vendor login, mutates SSH, creates VMs, or performs authenticated Linear/OpenRouter probes.

`--json` and non-TTY setup do not prompt or create empty config. Setup and doctor use human output by default, JSON when requested. Exit status `0` means checks pass, `1` means blocked or failed, and `130` means setup prompt interruption. `maquila doctor` repeats read-only readiness checks: resolves target and GitHub base, performs a GitHub target/base read, resolves Linear/OpenRouter credentials without API probes, checks pinned models against OpenRouter's anonymous catalog, and lists exe.dev VMs without creating one. SSH identity paths must be absolute; host-key verification remains strict. GitHub, Linear, and OpenRouter resolution stays controller-side; OpenRouter remains a dedicated capped key's transient VM exception during runs.

Run the isolated happy-path mock with `bun run prototype:setup`; it uses temporary config plus injected credential, GitHub snapshot, model-catalog, and VM-list mocks, then deletes the temporary state. The real journey remains `maquila setup --target /path/to/project`, followed by `maquila run start --target /path/to/project --issue RIFF-52`; `maquila doctor` repeats readiness checks when needed. No credentialed end-to-end setup proof is claimed. Inspect `scripts/prototype-setup-happy-path.ts`, `src/setup.ts`, `src/doctor.ts`, `src/cli/parse.ts`, `src/cli/commands/setup-doctor.ts`, `src/cli/index.ts`, `test/setup.test.ts`, `test/doctor.test.ts`, and `test/cli.test.ts` before changing this surface.

Build and link the current-platform standalone executable with `bun run build` then `bun link`. Commands target current working directory by default; `--target PATH` overrides it. Human output is default; `--json` is machine mode. The global command stays linked to the checkout because runtime agent definitions, skill files, and the source archive remain repository-owned. `bun run build:binary` rebuilds only `dist/maquila`; check `test -x ./dist/maquila` before linking, or run `maquila doctor`, which reports a missing binary and its `bun run build` remedy.

`dist/maquila` is a Bun-compiled native executable for the OS and CPU where it was built. Do not copy one platform's binary to another. During `maquila run`, the controller copies the checkout to the exe.dev VM, runs `bun install --frozen-lockfile`, builds there with Bun, then runs that VM-local `dist/maquila` for planning, worker, verification, and review. The host's linked command is not the remote runtime.

`maquila setup` is guided only on a human TTY without action flags: it prints official credential links, optionally accepts missing Linear/OpenRouter `op://Vault/Item/field` references, validates them before atomically writing strict mode-`0600` config, then reports doctor readiness. Noninteractive and JSON setup only report and never create empty config. `maquila doctor` checks config, target, credential resolution, GitHub target/base read, anonymous model catalog, read-only exe.dev VM listing, built CLI, and skill; it creates no VM or credential validation request.

GitHub credential precedence: `GITHUB_TOKEN`, `GH_TOKEN`, `gh auth token`. Linear precedence: `LINEAR_API_TOKEN`, configured `op read` reference. OpenRouter precedence: `OPENROUTER_API_KEY`, configured `op read` reference. `maquila setup --openrouter-token-reference op://Vault/Item/field` stores only reference; `maquila doctor` checks resolution. exe.dev identity is optional through `--identity` or `MAQUILA_EXE_IDENTITY`; OpenSSH config and agent are supported, `SSH_AUTH_SOCK` is host-only, and SSH uses `ForwardAgent=no`. Linear and GitHub credentials remain controller-side; target repository and VM stay free of those credentials. OpenRouter key is transient VM exception and must be dedicated/capped; VM is not a security sandbox. Runtime state remains under Maquila checkout. No Linear OAuth, native keychain, or profiles exist.

## Local tooling

This repository uses Bun `1.3.14`, pinned by `package.json` and recorded in `bun.lock`. Use `bun install --frozen-lockfile`. Do not restore npm or pnpm lockfiles.

`bun run check` is the full local gate: type-aware Oxlint, Oxfmt verification, TypeScript checking, compiled Node tests, standalone binary compilation, and a read-only `--help` smoke check. Oxlint enables correctness and suspicious rules with TypeScript, Oxc, Unicorn, import, Node, and Promise plugins. Tests turn off only `typescript/no-floating-promises` and `typescript/no-unsafe-type-assertion`; this keeps the type-aware policy balanced for test code without disabling the broader checks. Oxfmt uses its defaults; `bun run format` writes them and `bun run format:check` verifies them.

Husky is local only: pre-commit runs `bunx lint-staged`, and pre-push runs `bun run check`. lint-staged runs `oxlint --fix` then Oxfmt on staged TypeScript and JavaScript files, and Oxfmt on staged JSON, Markdown, and YAML files. It preserves unstaged work while handling partial staging, and only its staged-file results enter the commit. Run the full gate before relying on these hooks.

An empty `trustedDependencies` list keeps dependency lifecycle scripts blocked unless explicitly reviewed and approved. There is no hosted CI workflow: checks run locally through these commands and hooks.

## Tests

`bun run test` covers recipe resolution, strict manifest and execution hashes, docs-only skip, serial stop behavior, local manifest fallback, state v2 cursor and v1 resume compatibility, protocol v2 rejection, telemetry identity, status/observer checkpoint display, controller sequence checks, harvest bindings, publication, role boundaries, credentials, and existing intake/observer behavior. Test counts are not promises; run current full gate.

## Failure and security limits

Bounded remote lifecycle errors are redacted and copied into controller receipts and public failure telemetry when available; full transcripts remain in failure evidence. Agent timeout is cooperative: the runner calls `session.abort()` and records `deadline_reached`. The controller then destroys its VM, which is the hard cancellation boundary when exe.dev deletion is available. Read-only tools do not prevent reads outside the repository, and source is sent to the configured model provider. VM isolation keeps Linear and GitHub write credentials controller-side, but no restrictive in-VM network or filesystem sandbox exists.

## Next

Run one credentialed end-to-end publication smoke test and one assigned-engineer same-session continuation smoke test. Then define the broader planning-output/delivery contract. Fix pass, hosted decision delivery, and poller reboot recovery remain out of scope.
