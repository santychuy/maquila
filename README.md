# Maquila

Maquila takes a Linear issue, works on it inside a fresh exe.dev VM, verifies the change, runs an independent review, and opens a ready-for-review GitHub pull request. It never merges. A human owns that decision.

## What you need

- Bun `1.3.14`
- Node.js `>=22.19.0` for source tests and remote target compatibility
- An exe.dev account
- GitHub CLI (`gh`) authenticated to the target repository
- A Linear personal API key or 1Password secret reference
- A dedicated, capped OpenRouter API key (or an `op://` reference)

## Install once

```bash
git clone git@github.com:santychuy/maquila.git
cd maquila

# Install, build the current platform binary, and expose it globally.
bun install --frozen-lockfile
bun run build
bun link
```

Confirm binary exists and inspect CLI without starting a Maquila workflow:

```bash
test -x ./dist/maquila
maquila --help
```

`bun run build:binary` rebuilds only the standalone executable for the current OS and CPU. `bun link` keeps the global command linked to this checkout because Maquila still needs its agent definitions, Pi skill, and source archive at runtime.

## Guided setup

Run setup from repository Maquila will change, or pass its path explicitly:

```bash
cd /path/to/your-project
maquila setup

# Equivalent from another directory:
maquila setup --target /path/to/your-project
```

Setup detects existing credentials, prints direct official links for anything missing, optionally accepts only 1Password `op://` references, and runs read-only readiness checks. It never accepts raw keys, opens browsers, changes SSH state, or creates a VM. Exit code is `0` when required checks pass and `1` when setup remains blocked.

After setup passes:

```bash
maquila run start --issue RIFF-52
```

## Credential details

Use these options when guided setup reports missing access.

### GitHub

Use browser login:

```bash
gh auth login --web --hostname github.com
```

Or create a fine-grained token at https://github.com/settings/personal-access-tokens/new and set `GITHUB_TOKEN`. For CI, `GH_TOKEN` also works.

### OpenRouter

Remote planner, worker, documenter, and reviewer sessions use the model pinned in each agent definition. Planner uses `openrouter/z-ai/glm-5.3`; worker, documenter, and reviewer use `openrouter/google/gemini-3.7-flash`. Agent definitions are authoritative, not a run-time `--model` override. The runtime does not bundle an OpenRouter model catalog; `maquila doctor` and remote bootstrap validate pinned identifiers against OpenRouter's live catalog. Agent requests cap maximum output at 16,384 tokens so provider credit checks remain bounded.

Create keys at https://openrouter.ai/settings/keys. Export a key for local commands:

```bash
export OPENROUTER_API_KEY=...
```

Or store only a 1Password reference in Maquila config:

```bash
maquila setup --openrouter-token-reference op://Vault/OpenRouter/api-key
```

Use a dedicated key with a spend/request cap. During `maquila run`, controller writes this key to a mode-`0600` Pi provider file in the VM, best-effort removes that file before VM destruction, then destroys VM. If cleanup fails, revoke dedicated key. This is deliberate transient exception to host-only credential handling; VM is not a security sandbox.

### Linear

Create keys at https://linear.app/settings/api. Choose one option.

### Shell or CI

```bash
export LINEAR_API_TOKEN=...
```

### 1Password

```bash
maquila setup --linear-token-reference op://Vault/Linear/token
```

Maquila stores only the `op://` reference, never the Linear key. Config lives at `$XDG_CONFIG_HOME/maquila/config.json` or `~/.config/maquila/config.json` with mode `0600`.

### exe.dev

Maquila uses SSH. If this works, you are ready:

```bash
ssh exe.dev whoami
```

Otherwise, create a dedicated key:

```bash
ssh-keygen \
  -t ed25519 \
  -C "maquila" \
  -f ~/.ssh/id_ed25519_exe
```

Add it to `~/.ssh/config`:

```sshconfig
Host exe.dev *.exe.xyz
  IdentitiesOnly yes
  IdentityFile ~/.ssh/id_ed25519_exe
```

Then connect and follow exe.dev registration:

```bash
ssh exe.dev
```

On first connection, verify the official exe.dev fingerprint before accepting it:

```text
SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo
```

If a different fingerprint appears, stop.

Existing exe.dev users can add the new public key from an authenticated session:

```bash
cat ~/.ssh/id_ed25519_exe.pub | ssh exe.dev ssh-key add
```

If the key has a passphrase, load it into your SSH agent:

```bash
ssh-add ~/.ssh/id_ed25519_exe
```

Alternative: skip SSH config and provide an absolute key path:

```bash
export MAQUILA_EXE_IDENTITY="$HOME/.ssh/id_ed25519_exe"
```

Maquila keeps the SSH key and agent on your host. It never copies them into the VM and explicitly disables agent forwarding.

See exe.dev's official SSH key setup: https://exe.dev/docs/cli-ssh-key

## Repeat readiness checks

Run `maquila doctor --target /path/to/your-project` later to repeat setup's read-only checks. It checks GitHub target/base access, credential resolution, anonymous model catalog, and exe.dev VM listing; it does not create a VM. Optional Pi skill install and 1Password CLI setup: https://developer.1password.com/docs/cli/get-started/.

## Start your first run

From the target repository:

```bash
# Start or reuse the local read-only web dashboard.
maquila dashboard

# Start work for this Linear issue.
maquila run start --issue RIFF-52
```

Expected output:

```text
Run: <run-id>
Status: running
Observer: http://127.0.0.1:4600/runs/<run-id>
```

Open that URL to watch progress.

Maquila requires the Linear issue to be `Todo` and assigned. It will:

1. Read the Linear issue and assignee.
2. Create a fresh exe.dev VM.
3. Plan and implement the change.
4. Run deterministic verification.
5. Run an independent review.
6. Destroy the VM.
7. Open a ready-for-review GitHub pull request.

If planning needs a human decision, Maquila pauses the same run, retains its VM, checkpoints the completed planner session on the controller, removes the VM-local OpenRouter configuration, and comments on the issue mentioning the request-time assignee. Reply in that thread with the numbered `Decision:` template. The detached controller polls every 30 seconds without holding the controller lock, accepts only a pinned-assignee reply for that request, rechecks the Linear and GitHub snapshots, restores the transient model configuration, and resumes the same planner session and VM. Each wait expires after 24 hours, and one run may request at most three decision rounds. Keep the detached controller process running while waiting; hosted webhooks and reboot-time polling recovery are not implemented.

The dashboard is read-only. It shows progress, verification, review, cleanup, failures, and pull-request status. It cannot start, cancel, approve, or merge work.

## Daily use

```bash
cd /path/to/your-project
maquila dashboard
maquila run start --issue RIFF-52
```

Run against another repository without changing directory:

```bash
maquila run start \
  --target /path/to/another-project \
  --issue RIFF-52
```

Check a run without the dashboard:

```bash
maquila run status --run-id <run-id>
```

## Use through Pi

After `maquila setup --install-skill`, open Pi from the target repository and run:

```text
/skill:maquila Run RIFF-52 in this repository
```

The skill calls the same deterministic Maquila CLI. It does not have a separate workflow or credential store.

## Automation

Human commands use short readable output. Scripts and the Pi skill use JSON:

```bash
maquila observer ensure --json
maquila run start --issue RIFF-52 --json
maquila run status --run-id <run-id> --json
```

`maquila observer ensure --json` is the machine-compatible form of `maquila dashboard`: start the local dashboard if absent, otherwise reuse the healthy process.

## Troubleshooting

Start here:

```bash
maquila doctor
```

Useful checks:

```bash
gh auth status
ssh exe.dev whoami
maquila observer status --json
```

Stop the dashboard process:

```bash
maquila observer stop --json
```

## Security and evidence

Linear and GitHub credentials stay in the host controller. OpenRouter uses a dedicated capped key as deliberate transient exception: controller passes it into VM-local Pi configuration for agent calls, best-effort removes it before VM destruction, then destroys VM. If cleanup fails, revoke dedicated key. VM is not a security sandbox. Runtime evidence remains under the Maquila checkout:

- `.maquila/telemetry/<run-id>.jsonl` — safe live event ledger
- `.maquila/controllers/<run-id>/` — controller state, patch, and harvested evidence
- `.maquila/runs/<run-id>/` — role receipts and transcripts
- `.maquila/observer.json` — private dashboard ownership descriptor

Generated `.maquila/` content is ignored by Git. The dashboard binds only to `127.0.0.1` and accepts read requests only. It exposes a prompt body only when requested through the loopback observer, after the pinned Maquila commit and telemetry SHA-256 fingerprint match. Transcripts, tool arguments/results, credentials, and repository content remain excluded.

## Current limits

Fix passes, in-flight resume, automatic merge, deployment, credential profiles, Linear OAuth/native keychain storage, and guaranteed cleanup while exe.dev deletion is unavailable are not implemented.

For implementation details, see [docs/observer.md](docs/observer.md), [ARCHITECTURE.md](ARCHITECTURE.md), [docs/envelopes.md](docs/envelopes.md), and [docs/foundation-checkpoint.md](docs/foundation-checkpoint.md).
