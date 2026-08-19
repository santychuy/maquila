# Software Factory

Small local software factory that runs bounded planner, worker, verification, and independent-review sessions inside a fresh exe.dev VM. Controller keeps Linear/GitHub authority on host, harvests evidence and patch, destroys VM, then stops at `ready_for_publication`. Human owns merge or rejection.

## Install

Requires Node.js `>=22.19.0` and pnpm `11.22.0`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm link --global
factory setup
factory doctor
```

`factory` uses current working directory as target by default. Pass `--target /absolute/path/to/repository` to override it. Commands print short human output by default; add `--json` for machine-readable output.

`factory setup` writes strict mode-`0600` config at `$XDG_CONFIG_HOME/factory/config.json` (or `~/.config/factory/config.json`). It can store only an optional Linear `op://Vault/Item/field` reference and can install the user-scope Pi skill with `--install-skill`. `factory doctor [--target PATH]` checks config, target, credentials, SSH, built CLI, and skill; it reports remediation for failures and warnings.

Credential precedence: GitHub uses `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`; Linear uses `LINEAR_API_TOKEN`, then configured `op://` reference through `op read`. CI environment credentials remain supported. exe.dev identity is optional (`--identity` or `FACTORY_EXE_IDENTITY`, absolute path). Without it, OpenSSH config and agent are supported. `SSH_AUTH_SOCK` stays host-only and SSH sets `ForwardAgent=no`. Linear and GitHub credentials remain controller-side; target repository and VM receive no credentials.

Runtime state currently remains under the Factory checkout in `.factory/`. There are no Linear OAuth, native keychain, or profile stores.

## Daily observed run

Start or reuse read-only local observer:

```bash
factory observer ensure --json
```

Start run against explicit target Git repository and return immediately:

```bash
cd /absolute/path/to/target-repository
factory run start --issue RIFF-52 --json
# Or from another directory:
factory run start --target /absolute/path/to/target-repository --issue RIFF-52 --json
```

Use `observer.url` from `observer ensure --json` and `runId` from `run start --json` to open `<observer.url>/runs/<runId>` (normally `http://127.0.0.1:4600/runs/<run-id>`). Dashboard polls canonical host telemetry and shows live phase, safe tool activity, deterministic gates, reviewer result, cleanup, failures, and safe artifact metadata. It has no workflow controls.

Check without browser:

```bash
factory run status --run-id <run-id> --json
factory observer status --json
```

Run observer in foreground, like a development server:

```bash
factory observer serve --port 4600
```

Stop only the descriptor- and health-verified observer process:

```bash
factory observer stop --json
```

Pi users can invoke `/skill:software-factory` from target repository. Skill requires only Linear issue ID and routes through installed `factory` commands.

## Evidence

- `.factory/telemetry/<run-id>.jsonl` — canonical safe live event ledger
- `.factory/controllers/<run-id>/` — host controller state, patch, and harvested evidence
- `.factory/runs/<run-id>/` — local/remote role receipts and transcripts
- `.factory/observer.json` — private observer ownership descriptor

All generated `.factory/` content is ignored by Git. Observer binds only `127.0.0.1`, accepts GET/HEAD only, serves no artifact content, and never exposes prompts, transcripts, reasoning, tool arguments/results, stdout/stderr, credentials, or repository files.

See [docs/observer.md](docs/observer.md), [ARCHITECTURE.md](ARCHITECTURE.md), [docs/envelopes.md](docs/envelopes.md), and [docs/foundation-checkpoint.md](docs/foundation-checkpoint.md).

## Limits

GitHub PR publication, fix pass, in-flight resume, automatic merge, deployment, and guaranteed cleanup while exe.dev deletion is unavailable remain absent. No credentialed live observer run has been recorded for this new slice yet; local fake lifecycle and deterministic tests are required before that smoke proof.
