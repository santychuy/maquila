# Automatic Linear intake on exe.dev

This is the supported hosted pilot: one Maquila-owned persistent controller VM, one configured repository, and one serial run at a time. Each accepted issue gets a separate fresh execution VM, which the controller destroys before publication finishes.

## Trigger contract

An issue is eligible only when all are true at controller intake:

- assigned;
- workflow state is exact `Todo` with Linear type `unstarted`;
- exact label `maquila-ready` is present.

Adding that label authorizes one automatic run. Webhooks only wake the service; controller refetches canonical Linear and GitHub facts, writes durable controller admission, and only then acknowledges launch before creating an execution VM. Manual `maquila run start` does not require the label.

## Deploy from the operator host

Run setup and preflight against the target checkout first:

```bash
maquila doctor --target /absolute/path/to/target-repository --json
```

Continue only when JSON reports `ok: true`. Then deploy through Maquila itself:

```bash
maquila intake deploy \
  --target /absolute/path/to/target-repository \
  --allow-credential-transfer \
  --ttl 24h \
  --controller-name maquila-controller \
  --port 8080
```

`--allow-credential-transfer` is required because deploy copies the resolved Linear, GitHub, and OpenRouter credentials into the trusted persistent VM. Use dedicated least-privilege credentials, especially a fine-grained GitHub token and capped OpenRouter key.

`--ttl` is optional. It accepts `m`, `h`, `d`, or `w` durations from one minute through 365 days, such as `30m`, `24h`, or `2w`. Omit it for an indefinite controller. A TTL deployment installs a persistent systemd timer inside the controller VM, reports its absolute `expiresAt`, and runs the same full cleanup used by `intake destroy`: stop intake, remove the Linear webhook, make the proxy private, revoke the dedicated key, and delete the VM. Failed pre-destruction cleanup retries after five minutes.

`deploy` performs the complete controller lifecycle:

1. packages the exact current local Maquila build and records its SHA-256;
2. creates a persistent `exeuntu` controller VM;
3. installs pinned Node and Bun plus the packaged CLI;
4. creates a dedicated exe.dev SSH identity inside the VM and registers only its public key;
5. clones the target GitHub repository;
6. transfers required controller credentials through temporary mode-`0600` files, never command arguments;
7. installs and starts the user-level `maquila-intake.service` with restart-on-failure;
8. configures exe.dev's HTTPS proxy and makes only that gateway public;
9. creates one marked Linear Issue webhook using a generated signing secret;
10. waits until the public gateway is reachable before reporting success.

The persistent host holds Linear, GitHub, OpenRouter, and dedicated exe.dev credentials. Execution VMs receive only the existing transient capped OpenRouter exception. Local deployment state stores VM identity, webhook ID, public key, target, source SHA, and package hash; it stores no API credential or webhook secret.

A dirty local checkout is allowed for this pilot and reported as `sourceDirty: true`; package SHA-256 is the exact deployed-build identity. Commit before production deployment when reproducibility matters.

## Inspect and destroy

```bash
maquila intake status --json
```

Healthy output reports deployment `running`, VM `running`, service `active`, and either `Expires: never` or the configured timestamp. It also reports whether that timestamp has passed.

Rollback is owned by the same CLI:

```bash
maquila intake destroy --json
```

Destroy removes the Linear webhook, makes the proxy private, revokes the dedicated exe.dev key, and deletes the controller VM. Ambiguous cleanup persists `cleanup_pending` instead of claiming success; rerun destroy after provider recovery. Operator state is intentionally separate from the VM, so it can remain stale after successful automatic self-destruction; a later destroy or deploy reconciles already-removed external resources before continuing.

`maquila intake serve` remains the internal host command. Normal operators use `deploy`, `status`, and `destroy` rather than provisioning the VM manually.

## Linear webhook behavior

Receiver verifies raw-body HMAC-SHA256, delivery UUID, event type/action, and one-minute timestamp freshness. It persists accepted delivery before replying `200` and enforces a four-second body/persistence deadline. Linear retries non-`200` responses. Bounded reconciliation performs a full assigned-`Todo`/`maquila-ready` scan each interval and persists every completed Relay page, so a later page failure cannot discard earlier candidates.

## Live acceptance proof

Use one newly approved issue only after `maquila intake status --json` is healthy.

1. Confirm issue is assigned `Todo` without `maquila-ready`.
2. Add exact `maquila-ready` label.
3. Wait for Maquila's idempotent Linear comment containing accepted run ID and 24-hour dashboard URL.
4. Open dashboard URL. Initial query token becomes a `Secure`, `HttpOnly`, `SameSite=Strict` cookie; root run list and other run IDs remain inaccessible.
5. Wait for ready-for-review PR and completed cleanup.
6. Confirm execution VM disappeared while controller VM remains running.
7. Replay or edit issue while label remains. Confirm no second automatic run.

If label disappears before controller claim, admission fails before VM creation. A durable issue-to-run claim reconciles process crashes; uncertain termination retains the claim, while confirmed pre-admission failure gets a fresh run ID on bounded retry. If an admitted workflow later fails, service does not start another run automatically. Fix cause and use explicit human retry.

## Operational boundary

The controller VM is credential-bearing infrastructure. Keep the target trusted and non-sensitive. The public exe.dev proxy exposes only signed Linear webhook intake and run-scoped read-only dashboard access. The temporary bearer dashboard URL appears in its Linear comment and service log, so restrict both to trusted viewers.
