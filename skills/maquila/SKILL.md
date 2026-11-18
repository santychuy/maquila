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

Ask both questions together, up front:

1. **Sandbox provider.** Only `exe.dev` is supported right now. Say so and confirm it.
2. **AI provider (optional).** Ask for the provider (`anthropic`, `openai`, or `openrouter`), the model id (suggest `claude-sonnet-5-5` for anthropic), and the API key. The user can skip this and set it later in the factory's Settings page. Never echo the key back, write it to a file in the repo, or put it on a command line.
3. **GitHub token (optional).** A fine-grained token (Contents + Pull requests read/write, this repo only) so the agent can open PRs.
4. **Linear API key (optional).** Issues labelled `maquila` become jobs. The user must create the `maquila` label in Linear.

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

## 4. Give the sandbox access to the repository

Create a key inside the VM and register it as a write-enabled deploy key. The key never leaves the VM.

```bash
ssh "$VM.exe.xyz" 'test -f ~/.ssh/maquila_repo || ssh-keygen -t ed25519 -N "" -C "maquila@'"$VM"'" -f ~/.ssh/maquila_repo -q; cat ~/.ssh/maquila_repo.pub' > /tmp/maquila_repo.pub
gh repo deploy-key add /tmp/maquila_repo.pub --repo "$OWNER/$REPO" --allow-write --title "maquila-$VM"
rm /tmp/maquila_repo.pub
```

If adding the key fails with a permissions error, the user is not an admin of the repo. Tell them so and stop.

## 5. Install the factory

Run the bundled bootstrap script inside the VM. It installs Node if needed, clones Maquila and the user's repo, and starts the `maquila` systemd service on port 8000. It is safe to re-run.

```bash
ssh "$VM.exe.xyz" "REPO_SSH_URL='$SSH_URL' bash -s" < scripts/bootstrap.sh
```

`scripts/bootstrap.sh` is relative to this skill's directory.

## 6. AI provider (only if the user gave one)

Write the factory settings over stdin so the key never appears in a process list or shell history. The fields are `provider`, `model`, and `apiKey`.

```bash
printf '{"provider":"%s","model":"%s","apiKey":"%s"}' "$PROVIDER" "$MODEL" "$KEY" \
  | ssh "$VM.exe.xyz" 'umask 077; mkdir -p ~/.maquila; cat > ~/.maquila/settings.json; sudo systemctl restart maquila'
```

## 6b. Integrations (only if the user gave a GitHub token and/or Linear key)

Append them to the service env file over stdin, with the same rules as the AI key: no echo, never on a command line, never in the repo.

```bash
printf 'GH_TOKEN=%s\nLINEAR_API_KEY=%s\n' "$GH_TOKEN" "$LINEAR_KEY" \
  | ssh "$VM.exe.xyz" 'umask 077; mkdir -p ~/.maquila; cat >> ~/.maquila/env; sudo systemctl restart maquila'
```

Write only the lines for the values the user gave. Remind them to create the `maquila` label in Linear.

## 7. Expose it and verify

```bash
ssh exe.dev share port "$VM" 8000
ssh "$VM.exe.xyz" 'curl -fsS localhost:8000/api/health'
```

Keep the VM **private** (the exe.dev default). The exe.dev proxy then lets only the user in, so Maquila needs no login of its own. Do not run `share set-public` unless the user explicitly asks.

## 8. Hand off

Reply with:

- The factory URL: `https://$VM.exe.xyz`
- Whether an AI provider is configured. If it is not, tell them to open **Settings** in the factory first.
- One line on how the factory stays in sync: it pulls the latest default branch before every job and pushes its work to branches.

## Troubleshooting

See [references/exe-dev.md](references/exe-dev.md) for exe.dev commands. Service logs: `ssh "$VM.exe.xyz" 'journalctl -u maquila -n 100 --no-pager'`.
