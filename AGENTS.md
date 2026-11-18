# Maquila — Agent Guide

> *Maquila*: a factory that assembles. Here, a **software factory**: a 24/7 coding agent attached to one codebase, living in a cloud sandbox.

This file is the source of truth for anyone (human or agent) working on this repo. `CLAUDE.md` is a symlink to it.

## Vision

Anyone can install **one skill**, run **one command** from inside their own repository, and end up with a running software factory for that codebase — no manual infra work.

```
npx skills add santychuy/maquila   →   "set up maquila"   →   https://<factory>.exe.xyz
```

The factory is three things combined:

| Element | What it gives us |
|---|---|
| **Durable agent** | Work survives restarts, runs long, resumes. Proactive, not just reactive. |
| **Channels** | Many ways to trigger work: web UI first; later webhooks, GitHub events, Slack, cron. |
| **Sandbox** | An always-on VM that owns a clone of the codebase and runs the agent 24/7. |

Durable agent + channels + sandbox = a proactive agent that works around the clock.

## Principles

1. **Core only.** Ship the smallest useful baseline. Users extend it with their own tools, integrations, and workflows. Don't add features "for later".
2. **One factory = one codebase.** Each factory is attached to exactly one repository (GitHub for now; GitLab later).
3. **Agent-led setup.** The user's own agent, guided by our skill, does the setup. The skill asks as little as possible.
4. **Pluggable by design, simple by default.** Sandbox provider, AI provider, and channels are swappable — but we implement exactly one of each until a second is needed.
5. **Open source, presentable.** Clear structure, clear docs, no secrets in the repo.
6. **UI last.** A crappy UI is fine. The agent, the codebase, and the durable loop come first.

## The user journey

1. User finds this repo / skills.sh, installs the `maquila` skill into their agent.
2. Inside their repo, they ask the agent to set up Maquila.
3. The skill asks only:
   - **Sandbox provider** (only `exe.dev` for now).
   - **AI provider + key** — *optional*; can be set later in the factory's Settings.
4. The agent provisions the sandbox, clones the repo, installs and starts the factory service.
5. The agent replies with the factory URL. The user opens it and is welcomed into a workspace with the agent and their code, ready for jobs.

### Codebase sync

The sandbox holds a git clone of the user's repo. The factory keeps it current (`git fetch` before each job, work on branches, push / open PRs) so the agent always sees what teammates push and teammates see what the agent does.

## Repository layout

```
skills/maquila/        The published skill (entry point). SKILL.md + scripts/ + references/
app/                   The factory service that runs inside the sandbox (agent + channels + UI)
docs/                  Design docs and decisions
AGENTS.md              This file (CLAUDE.md → symlink)
```

## Stack decisions

| Concern | Choice (v0) | Swappable later |
|---|---|---|
| Skill format | Agent Skills spec (`SKILL.md`), distributed via skills.sh | — |
| Sandbox | exe.dev VM | other sandbox providers |
| Agent | Pi coding agent + durable agents package | other agent runtimes |
| Codebase host | GitHub | GitLab |
| First channel | Web UI | webhooks, Slack, GitHub events, cron |

## Working on this repo

- Keep changes small and lean. Prefer deletion over addition.
- Never commit secrets. API keys live in the sandbox (env / settings), never in git.
- Every provider integration goes behind the narrowest possible interface, and only when a second implementation actually exists.
- Dogfooding: this repo is the first codebase we attach a factory to.
