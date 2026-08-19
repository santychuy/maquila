# Software Factory

Software Factory takes a Linear issue, works on it inside a fresh exe.dev VM, verifies the change, runs an independent review, and opens a ready-for-review GitHub pull request. It never merges. A human owns that decision.

## What you need

- Bun `1.3.14`
- Node.js `>=22.19.0` for source tests and remote target compatibility
- An exe.dev account
- GitHub CLI (`gh`) authenticated to the target repository
- A Linear personal API key or 1Password secret reference

## Install once

```bash
git clone git@github.com:santychuy/software-factory.git
cd software-factory

# Install, build the current platform binary, and expose it globally.
bun install --frozen-lockfile
bun run build
bun link
```

Confirm binary exists and inspect CLI without starting a Factory workflow:

```bash
test -x ./dist/factory
factory --help
```

`bun run build:binary` rebuilds only the standalone executable for the current OS and CPU. `bun link` keeps the global command linked to this checkout because Factory still needs its agent definitions, Pi skill, and source archive at runtime.

## Connect GitHub

```bash
gh auth login
```

Factory reuses this login. For CI, `GITHUB_TOKEN` or `GH_TOKEN` also works.

## Connect Linear

Choose one option.

### Shell or CI

```bash
export LINEAR_API_TOKEN=...
```

### 1Password

```bash
factory setup --linear-token-reference op://Vault/Linear/token
```

Factory stores only the `op://` reference, never the Linear key. Config lives at `$XDG_CONFIG_HOME/factory/config.json` or `~/.config/factory/config.json` with mode `0600`.

## Connect exe.dev

Factory uses SSH. If this works, you are ready:

```bash
ssh exe.dev whoami
```

Otherwise, create a dedicated key:

```bash
ssh-keygen \
  -t ed25519 \
  -C "software-factory" \
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
export FACTORY_EXE_IDENTITY="$HOME/.ssh/id_ed25519_exe"
```

Factory keeps the SSH key and agent on your host. It never copies them into the VM and explicitly disables agent forwarding.

See exe.dev's official [SSH key setup](https://exe.dev/docs/faq/ssh-key) and [SSH key management](https://exe.dev/docs/cli-ssh-key) documentation.

## Finish setup

Install the optional Pi skill:

```bash
factory setup --install-skill
```

Now enter the repository you want Factory to change:

```bash
cd /path/to/your-project
factory doctor
```

`factory doctor` checks the current repository, GitHub, Linear, exe.dev SSH, the built CLI, and the Pi skill. If something is missing, it prints the command needed to fix it.

## Start your first run

From the target repository:

```bash
# Start or reuse the local read-only web dashboard.
factory dashboard

# Start work for this Linear issue.
factory run start --issue RIFF-52
```

Expected output:

```text
Run: <run-id>
Status: running
Observer: http://127.0.0.1:4600/runs/<run-id>
```

Open that URL to watch progress.

Factory will:

1. Read the Linear issue.
2. Create a fresh exe.dev VM.
3. Plan and implement the change.
4. Run deterministic verification.
5. Run an independent review.
6. Destroy the VM.
7. Open a ready-for-review GitHub pull request.

The dashboard is read-only. It shows progress, verification, review, cleanup, failures, and pull-request status. It cannot start, cancel, approve, or merge work.

## Daily use

```bash
cd /path/to/your-project
factory dashboard
factory run start --issue RIFF-52
```

Run against another repository without changing directory:

```bash
factory run start \
  --target /path/to/another-project \
  --issue RIFF-52
```

Check a run without the dashboard:

```bash
factory run status --run-id <run-id>
```

## Use through Pi

After `factory setup --install-skill`, open Pi from the target repository and run:

```text
/skill:software-factory Run RIFF-52 in this repository
```

The skill calls the same deterministic Factory CLI. It does not have a separate workflow or credential store.

## Automation

Human commands use short readable output. Scripts and the Pi skill use JSON:

```bash
factory observer ensure --json
factory run start --issue RIFF-52 --json
factory run status --run-id <run-id> --json
```

`factory observer ensure --json` is the machine-compatible form of `factory dashboard`: start the local dashboard if absent, otherwise reuse the healthy process.

## Troubleshooting

Start here:

```bash
factory doctor
```

Useful checks:

```bash
gh auth status
ssh exe.dev whoami
factory observer status --json
```

Stop the dashboard process:

```bash
factory observer stop --json
```

## Security and evidence

Linear and GitHub credentials stay in the host controller. The target repository and exe.dev VM do not receive them. Runtime evidence remains under the Factory checkout:

- `.factory/telemetry/<run-id>.jsonl` — safe live event ledger
- `.factory/controllers/<run-id>/` — controller state, patch, and harvested evidence
- `.factory/runs/<run-id>/` — role receipts and transcripts
- `.factory/observer.json` — private dashboard ownership descriptor

Generated `.factory/` content is ignored by Git. The dashboard binds only to `127.0.0.1`, accepts read requests only, and does not expose credentials, prompts, transcripts, reasoning, tool arguments, command output, or repository files.

## Current limits

Fix passes, in-flight resume, automatic merge, deployment, credential profiles, Linear OAuth/native keychain storage, and guaranteed cleanup while exe.dev deletion is unavailable are not implemented.

For implementation details, see [docs/observer.md](docs/observer.md), [ARCHITECTURE.md](ARCHITECTURE.md), [docs/envelopes.md](docs/envelopes.md), and [docs/foundation-checkpoint.md](docs/foundation-checkpoint.md).
