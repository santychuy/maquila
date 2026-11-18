---
name: maquila
description: Sets up a Maquila software factory for the current GitHub repository, a 24/7 durable coding agent running in a cloud sandbox (exe.dev) with the codebase cloned and kept in sync, and returns its URL. Use when the user asks to set up, install, deploy, or create Maquila or a "software factory" for their repo.
license: MIT
compatibility: Requires git, ssh, and an authenticated GitHub CLI (gh) on the user's machine, plus an exe.dev account.
metadata:
  homepage: https://github.com/santychuy/maquila
---

# Maquila setup

Turn the repository the user is in into a running software factory: a sandbox VM that holds a clone of the repo and runs the Maquila service (durable Pi agent + web UI) 24/7.

You lead the whole process. Ask the user only what is listed under "Ask". Run every command yourself, show short progress updates, and stop with a clear message if a step fails.

## Ask

Ask both questions together, up front, in chat:

1. **Sandbox provider.** Only `exe.dev` is supported right now. Say so and confirm it.
2. **AI provider and model.** `anthropic`, `openai`, or `openrouter`; default `openrouter` / `anthropic/claude-sonnet-5.5` (one key for any model).

Never ask for keys or tokens in chat. If the user pastes one anyway, do not repeat it, and still use the secrets script (step 4).

## 1. Preflight (local machine)

```bash
git rev-parse --show-toplevel
gh repo view --json nameWithOwner,sshUrl,defaultBranchRef
gh auth status
```

Stop if this is not a git repo with a GitHub remote, or if `gh` is not authenticated (tell the user to run `gh auth login`). Record `OWNER/REPO`, `SSH_URL`, and the default branch.

Pick a VM name: `<repo>-maquila`, lowercased, containing only `a-z`, `0-9`, and `-`. Call it `VM`.

## 2. exe.dev account

```bash
ssh -o StrictHostKeyChecking=accept-new exe.dev ls --json
```

- If the output contains `"Registration is required"`, the user has no account or key yet. Ask them to run `ssh exe.dev` themselves in an interactive terminal (in Claude Code: `! ssh exe.dev`), finish signup, then tell you to continue. Re-run the check.
- If `vms[]` already contains `VM`, ask whether to reuse it (skip step 3) or choose another name.

## 3. Create the sandbox

```bash
ssh exe.dev new --name="$VM" --json
```

Wait until it is reachable (retry for up to 2 minutes):

```bash
ssh -o StrictHostKeyChecking=accept-new "$VM.exe.xyz" true
```

## 4. Secrets

The user enters their secrets in a masked prompt they run themselves, so values never reach this chat, a command line, shell history, or the repo. Tell them to run, in their own terminal, this command with the absolute path and values filled in:

```bash
bash <skill dir>/scripts/secrets.sh <VM> <OWNER/REPO> <provider>
```

It asks for an AI key, a GitHub token, and a Linear key; all optional, hidden input, each verified live. Say: run it in a separate terminal tab, not through your agent (agent shells, including Claude Code's `!` prefix, have no interactive input, so the script refuses to run there). Wait for the user to say done, then confirm names only:

```bash
ssh "$VM.exe.xyz" "cut -d= -f1 ~/.maquila/env"
```

## 5. Give the sandbox access to the repository

Create a key inside the VM and register it as a write-enabled deploy key. The key never leaves the VM.

```bash
ssh "$VM.exe.xyz" 'test -f ~/.ssh/maquila_repo || ssh-keygen -t ed25519 -N "" -C "maquila@'"$VM"'" -f ~/.ssh/maquila_repo -q; cat ~/.ssh/maquila_repo.pub' > /tmp/maquila_repo.pub
gh repo deploy-key add /tmp/maquila_repo.pub --repo "$OWNER/$REPO" --allow-write --title "maquila-$VM"
rm /tmp/maquila_repo.pub
```

If adding the key fails with a permissions error, the user is not an admin of the repo. Tell them so and stop.

## 6. Install the factory

Run the bundled bootstrap script inside the VM. It installs Node if needed, clones Maquila and the user's repo, and starts the `maquila` systemd service on port 8000. It is safe to re-run.

```bash
ssh "$VM.exe.xyz" "REPO_SSH_URL='$SSH_URL' bash -s" < scripts/bootstrap.sh
```

`scripts/bootstrap.sh` is relative to this skill's directory.

## 7. Provider and model

Write the settings (no key: keys live in `~/.maquila/env`) and restart:

```bash
printf '{"provider":"%s","model":"%s"}' "$PROVIDER" "$MODEL" \
  | ssh "$VM.exe.xyz" 'umask 077; mkdir -p ~/.maquila; cat > ~/.maquila/settings.json; sudo systemctl restart maquila'
```

## 8. Expose it and verify

```bash
ssh exe.dev share port "$VM" 8000
ssh "$VM.exe.xyz" 'curl -fsS localhost:8000/api/health'
```

If an AI key was saved, the health output must show `"providerConfigured":true`.

Keep the VM **private** (the exe.dev default). The exe.dev proxy then lets only the user in, so Maquila needs no login of its own. Do not run `share set-public` unless the user explicitly asks.

## 9. Hand off

Reply with:

- The factory URL: `https://$VM.exe.xyz`
- Which integrations are on, from the saved names (AI key, `GH_TOKEN` for PRs, `LINEAR_API_KEY` for Linear). If any was skipped, they can add it later in **Settings → Secrets** or by re-running the script.
- How to start a job: label a Linear issue `maquila`, or use the web UI.
- One line on how the factory stays in sync: it fetches before every job, branches each job from the latest default branch, and pushes its work to branches.
- If Linear is used, recommend enabling Linear's GitHub integration (Linear → Settings → Integrations → GitHub): branch names include the issue id, so issue status follows the PR.

## Tear down

```bash
ssh exe.dev rm "$VM"
gh repo deploy-key list --repo "$OWNER/$REPO"   # find the id of maquila-$VM
gh repo deploy-key delete <id> --repo "$OWNER/$REPO"
```

## Troubleshooting

See [references/exe-dev.md](references/exe-dev.md) for exe.dev commands. Service logs: `ssh "$VM.exe.xyz" 'journalctl -u maquila -n 100 --no-pager'`.
