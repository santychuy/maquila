# Setup and credentials

Install the package first; see [README](../README.md). Setup is read-only except for the XDG config and optional managed skill installation. It never logs in to vendors, accepts raw keys, changes SSH configuration, or creates a VM. Use a trusted, non-sensitive target repository.

```bash
maquila setup --target /absolute/path/to/project --install-skill
maquila doctor --target /absolute/path/to/project --json
```

Use `--json` for non-interactive agent setup. Store credentials in the host environment or supported `op://` references, not in an issue, SDK request, or prompt. Environment credentials take precedence over saved references.

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

## What readiness means

Generic setup/doctor check the GitHub target/base with an authenticated read, list exe.dev VMs, resolve Linear and OpenRouter credentials, and look up configured models in the anonymous OpenRouter catalog. They do not prove Linear issue access, GitHub write permission, model credits, or successful VM execution.

To check a specific issue:

```bash
maquila doctor --target /absolute/path/to/project \
  --issue "<ISSUE-ID>" --require-label maquila-ready --json
```

The issue must be accessible, assigned, and exactly `Todo`. Labels are case-sensitive. `--require-label` requires `--issue`. Stop on nonzero exit or JSON `ok: false`. Preflight is a point-in-time check, not an issue reservation or automatic trigger gate.

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
