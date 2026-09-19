# Setup and credentials

Install the package first; see [README](../README.md). Setup is read-only except for the XDG config and optional managed skill installation. It never logs in to vendors, changes SSH configuration, or creates a VM. Human TTY setup can paste Linear and OpenRouter API keys into a hidden prompt; agents and `--json` never receive those keys. Use a trusted, non-sensitive target repository.

```bash
cd /absolute/path/to/project
maquila setup --install-skill
maquila doctor --json
```

Commands target the current directory; pass `--target PATH` only to aim elsewhere.

To set up from zero — counting a credential only after you choose it in this walkthrough — run:

```bash
maquila setup --from-scratch
```

It visits GitHub, Linear, OpenRouter, exe.dev SSH, and the Pi skill one at a time. Saved config is not used unless you choose a station. Skipped stations keep setup incomplete even if this process still has leftover environment variables. Linear and OpenRouter default to a hidden API-key paste. Environment variables remain valid. 1Password `op://` references are optional, validated without environment tokens shadowing them, and merged into existing config on save. Declining to save leaves setup incomplete. Confirmed keys are stored unencrypted in owner-only host config, never under the target repository; an `XDG_CONFIG_HOME` inside the target fails closed. Exporting `GITHUB_TOKEN`, `LINEAR_API_TOKEN`, `OPENROUTER_API_KEY`, or `MAQUILA_EXE_IDENTITY` in another shell cannot change this process; restart setup after export. `gh auth login` and `op` persist and can be rechecked without restart. There is no raw-key CLI flag. Plain stdlib prompts, no prompt-framework dependency.

On a TTY, setup runs a step-by-step wizard even with `--install-skill`. Pass `--json`, `--agent`, or credential reference flags for a single-run non-interactive path.

Use `--agent` for progressive agent setup: the same checks render as markdown with `Resolved` and `Pending` sections, each pending check carrying its fix and a machine-readable `{check, status, via}` block. It accepts partial values across calls and never prompts for secrets. `--agent` cannot be combined with `--json`. Agent mode also auto-activates when a known agent environment is detected (explicit `--agent` wins). Store credentials in host config, the host environment, or optional `op://` references, not in an issue, SDK request, or prompt. Environment credentials take precedence over saved keys and references.

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

Or paste it during `maquila setup`. Optional 1Password:

```bash
maquila setup --openrouter-token-reference op://Vault/OpenRouter/api-key
```

Use a dedicated key with a spend/request cap. During `maquila run`, controller writes this key to a mode-`0600` Pi provider file in the VM, best-effort removes that file before VM destruction, then destroys VM. If cleanup fails, revoke dedicated key. This is deliberate transient exception to host-only credential handling; VM is not a security sandbox.

### Linear

Create keys at https://linear.app/settings/api. On a TTY, `maquila setup` can paste the key into a hidden prompt. For shell or CI:

```bash
export LINEAR_API_TOKEN=...
```

Optional 1Password:

```bash
maquila setup --linear-token-reference op://Vault/Linear/token
```

Config lives at `$XDG_CONFIG_HOME/maquila/config.json` or `~/.config/maquila/config.json` with directory mode `0700` and file mode `0600`. Saved API keys are unencrypted; other processes running as the same user can read them. Never commit this file.

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

## What readiness means

Generic setup/doctor check the GitHub target/base with an authenticated read, list exe.dev VMs, resolve Linear and OpenRouter credentials, read Linear viewer/workspace identity (no email), read OpenRouter key limit metadata, and look up configured models in the anonymous OpenRouter catalog. They do not prove Linear issue access unless `--issue` is passed, GitHub write permission, a specific dollar spend cap, exe.dev billing, or successful VM execution. An unlimited, resetting, or BYOK-excluded OpenRouter limit is a warning, not a fixed spending lock. Setup and doctor JSON expose `linearIdentity` and `openRouterKey` metadata without key labels, hashes, or raw credentials. An exhausted key fails readiness; remaining key allowance does not prove the account has enough funded credits. See [OpenRouter credit limits](https://openrouter.ai/docs/api/reference/limits).

To check a specific issue:

```bash
maquila doctor --issue "<ISSUE-ID>" --json
```

The issue must be accessible, assigned, exactly `Todo`, and carry the `maquila-ready` label. Labels are case-sensitive. `--require-label LABEL` overrides the default label; `--require-label ""` skips the label check. `--require-label` requires `--issue`. Stop on nonzero exit or JSON `ok: false`. Preflight is a point-in-time check, not an issue reservation or automatic trigger gate.

## Repeatable skill installation

`setup --install-skill` installs `.pi/agent/skills/maquila/SKILL.md` under your home directory. Repeating setup accepts identical content without overwriting it. Existing managed links from checkout-based setup remain accepted. Different content and unrelated links require manual review; setup does not replace them silently.

## State and upgrades

The package code and runtime assets are read-only inputs. Controller and observer state is kept under a separate host home. Local `pi plan` and `pi worker` development commands retain cwd-relative role evidence:

| Mode                         | State directory                                                          |
| ---------------------------- | ------------------------------------------------------------------------ |
| Installed package            | `$XDG_STATE_HOME/maquila/.maquila`, or `~/.local/state/maquila/.maquila` |
| Explicit host home           | `$MAQUILA_HOME/.maquila`                                                 |
| Source checkout, no override | `<Maquila checkout>/.maquila`                                            |
| SDK                          | The exact absolute `stateDirectory` supplied by the host                 |

`MAQUILA_HOME` and `XDG_STATE_HOME` must be normalized absolute paths. Use the same host home for start, status, resume, batch, and observer commands. Do not place it in the target repository or installed package. Do not upgrade the package while a run is active or waiting for a decision; retained decision resume requires the pinned runtime to match. Archive and back up evidence before removing a host home.

The SDK does not read `MAQUILA_HOME` to override its explicit state directory. Config stays at `$XDG_CONFIG_HOME/maquila/config.json` or `~/.config/maquila/config.json`.
