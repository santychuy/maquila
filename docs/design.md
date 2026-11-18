# Design (v0)

Goal: from inside any GitHub repo, a single skill invocation produces a running, private, 24/7 software factory for that repo.

## Components

### 1. The skill: `skills/maquila/`

- It follows the [Agent Skills](https://agentskills.io) format: `SKILL.md` with `name` + `description` frontmatter, plus `scripts/` and `references/` loaded on demand.
- It is distributed through [skills.sh](https://skills.sh): `npx skills add santychuy/maquila --skill maquila`. The CLI discovers `skills/<name>/SKILL.md`, and skills.sh lists the repo automatically after the first installs, so no manifest is needed.
- The skill is named `maquila`, not `setup`, because skill names share one namespace inside an agent. "Setup" is the job the skill does.
- The agent runs everything locally over `ssh` and `gh`. The VM side is one idempotent script, `scripts/bootstrap.sh`.

### 2. The sandbox: exe.dev

Why exe.dev: a real VM with systemd, persistent disk, an HTTPS proxy that is private by default, and a control plane that is plain SSH. Our setup needs no SDK and no API token.

| Need | How |
|---|---|
| Create | `ssh exe.dev new --name=<repo>-maquila --json` |
| Run / install | `ssh <vm>.exe.xyz 'bash -s' < bootstrap.sh` |
| Expose | `ssh exe.dev share port <vm> 8000` → `https://<vm>.exe.xyz` |
| Auth | Private proxy. Only the owner gets in, and the app receives `X-ExeDev-Email` |

### 3. Codebase access and sync

- The VM generates its own SSH key. The user's machine registers it as a **write-enabled deploy key** with `gh repo deploy-key add`. No GitHub token ever leaves the user's machine, and the key is scoped to the one repo.
- The factory runs `git fetch` + `git pull --ff-only` before every job and never discards local changes. The agent pushes its work to branches.

### 4. The factory service: `app/`

- One Node (≥ 22.19) process, run directly from TypeScript and managed by systemd (`maquila.service`, `Restart=always`).
- Agent: [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) with SQLite storage at `~/.maquila/agent.sqlite`. It provides the coding tools (`read`/`write`/`edit`/`bash`) on the repo and calls `resume()` on boot, so unfinished runs continue after a crash or reboot.
- AI provider: optional. It can be set at setup or later in Settings (both write `~/.maquila/settings.json`, mode 600). Keys are never sent back to the browser.
- First channel: the web UI (prompt + live event stream + settings).

## Layout on the VM

```
~/maquila/                 clone of this repo (the service code)
~/<repo>/                  clone of the user's codebase (the agent's cwd)
~/.maquila/settings.json   provider, model, API key
~/.maquila/agent.sqlite    durable agent storage
~/.maquila/env             optional extra env vars for the service
```

## Extending Maquila (users)

Two primitives, both plain files you drop in and load on restart (`sudo systemctl restart maquila`). Custom files may import only node builtins and the packages already in `app/` (no install step yet). The contract is in `app/src/factory.ts`.

**Channels** bring work in. Put a `.ts`/`.js` file in `~/.maquila/channels/` whose default export is a `Channel`: it gets the `factory` (`run`, `resume`, `syncRepo`, `subscribe`, `repo`, `home`), reads its own config from `process.env`, and returns early when unconfigured. A channel that throws is logged and skipped. Linear (`app/src/channels/linear.ts`) is built this way.

Examples: see the README.

## Extension points (not built yet, on purpose)

| Axis | v0 | Next candidates |
|---|---|---|
| Sandbox provider | exe.dev | Fly Machines, E2B, Daytona, Modal |
| Code host | GitHub | GitLab |
| Channels | Web UI (core) + `Channel` files (Linear built in) | GitHub webhooks, Slack, cron, email |
| Agent extensions | pi-durable `defineExtension` files | the same |
| Agent runtime | Pi durable | other agent runtimes |

When the second implementation of an axis lands, extract the narrowest interface the two need. Not before.

## Open questions

- PR creation from the VM: a deploy key cannot open PRs. For now a fine-grained token in `~/.maquila/env` (`GH_TOKEN`) solves it; a GitHub App is likely the right long-term answer.
- Updating a running factory: re-run `bootstrap.sh` (it is idempotent), or add an "update" action to the skill.
- Multiple users per factory: exe.dev `share add` already provides access control, but agent identity per user is undecided.
- Public ingress for webhook channels: avoided for now by polling (Linear). Webhooks would need their own auth, since exe.dev allows only one public port per VM.
