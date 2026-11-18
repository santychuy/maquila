# Evidence sources

Read only what the run touched. Never print secret values; names only.

## Run transcript
The conversation itself: look for user interventions, retries, "did it work?", agent turns that ended early, and tool errors.

## Multiplexer panes (leftovers)
- Rex: `rex block ls`, `rex capture <pane>` to read output.
- tmux: `tmux list-panes -a`, `tmux capture-pane -p -t <pane>`.
Expect only the user's original panes at the end.

## Factory (over ssh, `VM` = `<repo>-maquila`)
```bash
ssh $VM.exe.xyz 'curl -fsS localhost:8000/api/health'
ssh $VM.exe.xyz 'curl -fsS localhost:8000/api/jobs'
ssh $VM.exe.xyz 'curl -fsS localhost:8000/api/jobs/<id>'
ssh $VM.exe.xyz 'journalctl -u maquila -n 200 --no-pager'
ssh $VM.exe.xyz 'ls -la ~/.maquila'
```

## GitHub
```bash
gh pr view <n> --json state,author,url
gh pr checks <n>
gh repo deploy-key list --repo OWNER/REPO
git branch -a            # stale job branches
```

## Linear
Via MCP: `get_issue`, `list_comments` (who posted, what), and status transitions for the issue.

## exe.dev
```bash
ssh exe.dev ls --json
ssh exe.dev share show <VM>
```
Look for VMs that should not exist and wrong visibility (should be private).

## User's working tree
`git status --short` and `git diff --stat` in the user's repo: any change the run was not asked to make (e.g. an edited `.mcp.json`) is a friction. Also check `/tmp` for leftovers such as `maquila_repo.pub`.
