# Maquila

Maquila takes an assigned Linear issue, works on it in a fresh exe.dev VM, verifies the change, runs an independent review, and opens a GitHub pull request. **It never merges. A human makes that decision.**

The package is **`@santychuy/maquila`**. The command is **`maquila`**. License: [Apache 2.0](LICENSE).

> Release preparation is in progress. The package has a checkout-independent install path, but the first npm publication is not yet confirmed. Do not install the unrelated unscoped `maquila` package.

## Install

The installed CLI runs on **Node.js >=22.19.0**. You also need Git, OpenSSH, access to the target GitHub repository, Linear, exe.dev, and a dedicated capped OpenRouter key. GitHub CLI (`gh`) is optional with `GITHUB_TOKEN` for non-visual work; UI runs require `gh pr edit --help` to list `--attach`. Bun is needed to build Maquila from source, not to run the installed JavaScript CLI.

Before the first registry release, install a maintainer-built tarball with npm or bun:

```bash
npm install -g /absolute/path/to/santychuy-maquila-0.1.0.tgz
maquila --help
```

After the package is published:

```bash
npm install -g @santychuy/maquila
```

`bun add --global` of the same tarball or package name also works. The first npm publication is not yet confirmed; do not install the unrelated unscoped `maquila` package. The SDK can be added to a host project with `npm install @santychuy/maquila` after publication, or with the tarball path before publication. The public artifact ships JavaScript, declarations, agent/skill assets, and a source runtime archive. It does not ship a platform-specific executable. The standalone binary remains a source-development convenience.

## Set up one project

Run these from your terminal or have an operating agent use the JSON forms:

```bash
cd /absolute/path/to/project
maquila setup --install-skill
maquila doctor --json
```

On a TTY, `maquila setup --install-skill` installs the Pi skill and still walks guided checks. Missing Linear/OpenRouter credentials open a paste-first walkthrough: hidden terminal paste, environment variable, or optional 1Password. `--json` and `--agent` stay non-interactive and never prompt for secrets. Confirmed keys are stored unencrypted in owner-only host config (`0600`), never in the target repository, CLI flags, issues, or telemetry. It does not create a VM or start work. See [setup and credentials](docs/setup.md) for vendor access, readiness limits, state paths, and upgrades.

## Run one issue

The Linear issue must be assigned, in `Todo`, and carry the exact `maquila-ready` label:

```bash
cd /absolute/path/to/project
maquila doctor --issue "<ISSUE-ID>" --json
```

**Stop if preflight fails.** When it passes and you intend to spend VM/model credits and create a PR:

```bash
maquila dashboard
maquila run start --issue "<ISSUE-ID>" --json
maquila run status --run-id "<RUN-ID>" --json
```

Start returns an accepted run ID, not a completed result. The read-only dashboard shows progress, evidence, cleanup, and the PR URL. Planner-classified web UI work must produce at least two validated screenshots in VM; short video is best effort. Host controller attaches visuals to PR body before marking draft ready. You can close the initiating terminal after detached startup, but the local host must stay running.

If planning needs a decision, Maquila pauses and posts a numbered Linear thread for the issue's pinned assignee. That assignee replies with the `Decision:` template. The controller can resume the same planner session. Waits expire after 24 hours; there is no reboot-time service that automatically restarts polling.

## Use through an agent

The installed Pi skill routes through the same public commands:

```text
/skill:maquila Run <ISSUE-ID> against /absolute/path/to/project
```

Other agents can use `setup --agent`, `doctor --agent`, `run start --json`, and `run status --json` (`--json` also works for setup/doctor). Keep credentials in the controller's environment, not in model prompts. The operating agent starts and observes work; it cannot replace deterministic acceptance gates.

**Automatic intake is opt-in.** `maquila intake deploy --target PATH --allow-credential-transfer` provisions the persistent exe.dev controller, installs the exact current build, configures its HTTPS proxy and Linear webhook, and starts the managed intake service. Assigned `Todo` issues carrying exact `maquila-ready` get one admitted automatic run and an idempotent Linear comment with a 24-hour dashboard URL. Use `maquila intake status` and `maquila intake destroy` for inspection and rollback. Manual `run start` does not require the label. See [automatic intake deployment](docs/automatic-intake.md).

## Use the SDK

```ts
import {
  createMaquila,
  createLinearWorkItemProvider,
  createGitHubSourceControlProvider,
  createExeExecutionProvider,
} from "@santychuy/maquila";

const maquila = createMaquila({
  workItemProvider: createLinearWorkItemProvider({ token: process.env.LINEAR_API_TOKEN! }),
  sourceControlProvider: createGitHubSourceControlProvider({ token: process.env.GITHUB_TOKEN! }),
  executionProvider: createExeExecutionProvider(),
  stateDirectory: "/absolute/path/to/maquila-state",
  openRouterApiKey: process.env.OPENROUTER_API_KEY!,
});

const result = await maquila.run({
  workItem: { provider: "linear", id: "<ISSUE-ID>" },
  sourceControl: { provider: "github", repository: "owner/repository", baseRef: "main" },
  execution: { provider: "exe.dev", tag: "repository-tag" },
});
```

`run()` blocks until completed, failed, or cancelled. The host owns queues and process lifetime. Credentials belong to instance configuration only. `stateDirectory` is used exactly as supplied; the SDK never appends `.maquila`.

There are four provider seams: `WorkItemProvider`, `SourceControlProvider`, `ExecutionProvider`, and optional best-effort `EventSink`. The SDK does not expose detached start/status/resume/batch methods or controller controls. It remains Git/PR-oriented with one code-controlled `feature-pr` recipe—not a general workflow engine or GitHub Issues adapter.

## Safety and current limits

- Controller code owns intake, budgets, verification, review gates, cleanup, and PR publication.
- Linear and GitHub write credentials stay outside the execution VM. The dedicated capped OpenRouter key is a deliberate transient exception. Revoke it if VM cleanup fails.
- The VM is **not a security sandbox**. Use trusted, non-sensitive repositories.
- Failed verification or review does not publish a PR. Fix passes, general interrupted-request resume, automatic merge, and deployment are not implemented.
- Local deterministic and packed-install tests are not proof of a real Linear-to-PR run. See the [verified checkpoint](docs/foundation-checkpoint.md).

## Development and release checks

Source development requires Bun **1.3.14** and Node.js **>=22.19.0**:

```bash
bun install --frozen-lockfile
bun run check
bun run check:package
```

`check:package` builds a committed temporary source snapshot, installs its tarball in a fresh consumer, checks CLI/SDK/setup/state, and rebuilds the shipped runtime without Git metadata. It uses package-registry downloads but no Linear calls, VM creation, model requests, or PR publication.

See [releasing](docs/releasing.md) for clean-source packaging, public-exposure checks, supported-platform evidence, and registry publication. The npm artifact excludes the standalone binary, source maps, compiled tests, dependencies, and local runtime state. Browser-bundle licenses are in [third-party notices](THIRD_PARTY_NOTICES.md); separately installed dependencies retain their own licenses.

More detail: [setup](docs/setup.md) · [architecture](ARCHITECTURE.md) · [workflows](docs/workflows.md) · [observer](docs/observer.md).
