# Releasing Maquila

## Current release contract

- Package: `@santychuy/maquila`; executable name: `maquila`.
- License: Apache-2.0. Browser-bundle attribution is in `THIRD_PARTY_NOTICES.md`.
- Public artifact: Node.js ESM, TypeScript declarations, agent and skill assets, guides, and a pinned source runtime archive. No native executable or installed dependencies are bundled.
- Host commands need Node.js >=22.19.0, Git, and OpenSSH. Bun 1.3.14 is the source build/package manager and is bootstrapped separately in the VM.
- Local validation currently covers macOS arm64. Cross-platform CI evidence is not yet available; do not claim Linux/Windows install validation from a portable entry point alone.

GitHub visibility and npm publication are separate operations. A public GitHub repository does not publish an npm package. Do not install the unrelated unscoped `maquila` package.

## 1. Review before public exposure

Review tracked files, all reachable Git history, GitHub issues/PRs, and Actions logs before making a private repository public. Confirm no credentials, customer data, or private runtime artifacts are exposed. A scanner is useful evidence, not proof that all sensitive material has been found.

Never include `.maquila`, `.git`, `node_modules`, local environment files, or generated native executables in a release. If a real secret appears in history, stop and rotate it before considering history cleanup or publication. Do not silently rewrite history.

Review dependency changes before regenerating browser notices:

```bash
bun scripts/build-notices.ts
```

This command covers the embedded Preact/Day.js observer bundle, not a legal approval of every dependency. Dependencies installed separately retain their own distribution licenses. If native binaries are distributed later, separately review the complete embedded dependency graph and Bun runtime terms.

## 2. Run local acceptance

```bash
bun install --frozen-lockfile
bun run check
bun run check:package
```

The package check does not commit the real checkout. It creates a temporary Git source snapshot, builds and packs it, installs into a fresh consumer, checks SDK/CLI/setup/offline doctor/state behavior, and rebuilds the source runtime outside Git. It performs registry downloads only. It must not create exe.dev VMs, use model credits, mutate Linear, or publish pull requests.

A fixture package proves the install mechanism. It is not the final release artifact and its temporary source SHA is not a published repository commit.

## 3. Freeze and pack the real release

Review and commit the intended release changes through the project's normal human-approved Git workflow. Ensure the selected version is unused in the intended npm scope and the release source commit is available in the public repository. Never package an unreviewed dirty tree.

```bash
git status --short
bun run check
bun pm pack
```

`prepack` runs `build:package`. `build:runtime` refuses tracked or untracked source changes. It archives the exact committed `HEAD`, records the real 40-character source SHA, and records the archive SHA-256. The controller verifies packaged bytes and the embedded source identity before using them. These hashes prove consistency, not authenticity against a party that can replace both the package and its metadata.

Inspect the resulting tarball and record its filename, checksum, source commit, version, and test results. Do not bypass the source check with `--ignore-scripts` for a real release. That option is used only inside the isolated package test after an explicit build.

## 4. Publish only the reviewed artifact

An authenticated npm account with publish rights to `@santychuy` is required. Check the account without exposing tokens:

```bash
bun pm whoami
```

After the release owner approves publication, publish the reviewed tarball with public access using the package manager. Do not put credentials in commands, scripts, source, or chat. Publishing a tarball bypasses package lifecycle scripts; the artifact must already have passed the release checks.

After publication, verify registry name/version/license/integrity and install that exact registry version in another fresh consumer. A local tarball test is not evidence of successful registry publication. Update README release status only after this verification.

## 5. Proceed to the Bookbounce pilot separately

Only after install/release acceptance, request permission for one real assigned Linear `Todo` issue labeled exactly `maquila-ready` against `santychuy/bookbounce`. The live test spends VM/model credits and can create a PR. No automatic-intake service is enabled by publishing this package, and human merge remains mandatory.
