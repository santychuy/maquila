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

## How to run this

- You drive every step yourself, with short progress updates; stop with a clear message if a step fails. Ask the user only for: the in-chat answers under "Ask", interactive signups/logins, secrets in the hidden prompt, and approving OAuth/MCP sign-ins.
- Interactive commands (`ssh exe.dev` signup, `secrets.sh`) need a real terminal: agent shells (including Claude Code's `!`) have no interactive stdin. If you can control a terminal multiplexer (e.g. tmux, zellij, herdr, Rex), open a new pane in the repo directory (an interactive shell pane, so it stays open after the command exits), type the command into that shell, and tell the user to answer in that pane. Do not end your turn: in the same turn, run one long-running polling command (generous timeout, e.g. 15 min) that reads the pane's output until a completion marker appears (`secrets.sh`: a line starting with `Saved to ` or `Nothing saved`; `ssh exe.dev` signup: the shell prompt returns / connection closed). Then read the output, relay the ✓/✗ and `Saved to` lines (names only, never values), close the pane, and continue to the next step automatically. Otherwise ask the user to run it in a separate terminal tab and tell you when done. Call this the **pane rule**.
- Clean up: before the hand-off, close every pane/tab/session you opened and delete temp files you created (e.g. the deploy key `.pub` file). Leave the user's working tree as you found it.

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

- If the output contains `"Registration is required"`, the user has no account or key yet. Run `ssh exe.dev` per the pane rule so the user can finish signup, then re-run the check.
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

The user enters secrets in a masked prompt, so values never reach this chat, a command line, shell history, or the repo. First list the token pages (tab-separated `NAME`, `URL`, `hint`):

```bash
bash <skill dir>/scripts/secrets.sh --links <VM> <OWNER/REPO> <provider>
```

Offer to open them in the user's browser (`open` on macOS, `xdg-open` on Linux) so they can create the tokens; the GitHub link is pre-filled except the repository selection. Then run the prompt per the pane rule (absolute path, values filled in):

```bash
bash <skill dir>/scripts/secrets.sh <VM> <OWNER/REPO> <provider>
```

It asks for an AI key, a GitHub token, and a Linear key; all optional, hidden input, each verified live. When it finishes, confirm names only:

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

## 9. Linear

Only if the user saved `LINEAR_API_KEY`.

- With Linear MCP tools (e.g. `list_issue_labels` / `save_issue_label`): check for a workspace label named `maquila` and create it if missing (description: "Issues with this label are worked by the Maquila factory"). Ask which team/project the repo's issues live in only if you will file a test issue.
- Without them, recommend Linear's official MCP server so you can do this and future Linear work: `https://mcp.linear.app/mcp` (streamable HTTP, OAuth). Ask first, and add it at a scope that does not touch their repo (never edit the committed `.mcp.json`); in Claude Code: `claude mcp add --transport http --scope local linear https://mcp.linear.app/mcp`. Tell the user the tools may only appear after a session restart/reload and that they sign in via `/mcp`; resume this step afterwards. If they decline, ask them to create the `maquila` label themselves.
- Tip: Linear's GitHub integration (Linear → Settings → Integrations → GitHub) makes issue status follow the PR, since branch names include the issue id.

## 10. Hand off

Reply with:

- The factory URL: `https://$VM.exe.xyz`
- Which integrations are on, from the saved names (AI key, `GH_TOKEN` for PRs, `LINEAR_API_KEY` for Linear). If any was skipped, they can add it later in **Settings → Secrets** or by re-running the script.
- How to start a job: label a Linear issue `maquila`, or use the web UI. **Jobs** shows each run's status, PR and transcript. Offer to file a small first issue with the `maquila` label (via the Linear MCP) so they see the factory pick it up, open a PR, and comment back within a couple of minutes.
- One line on how the factory stays in sync: it fetches before every job, branches each job from the latest default branch, and pushes its work to branches.

## Tear down

```bash
ssh exe.dev rm "$VM"
gh repo deploy-key list --repo "$OWNER/$REPO"   # find the id of maquila-$VM
gh repo deploy-key delete <id> --repo "$OWNER/$REPO"
```

## Troubleshooting

See [references/exe-dev.md](references/exe-dev.md) for exe.dev commands. Service logs: `ssh "$VM.exe.xyz" 'journalctl -u maquila -n 100 --no-pager'`.
