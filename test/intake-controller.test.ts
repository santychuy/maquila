import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NODE_CHECKSUMS } from "../src/controller.js";
import { ExeClient, type ExecResult, type ExeVm } from "../src/integrations/exe.js";
import {
  deployIntakeController,
  destroyIntakeController,
  type ControllerPackage,
} from "../src/intake-controller.js";
import { readIntakeControllerState } from "../src/intake-controller-state.js";

const PUBLIC_KEY = `ssh-ed25519 ${"A".repeat(68)} maquila-controller`;

class FakeExe extends ExeClient {
  readonly commands: string[][] = [];
  readonly copies: Array<{ local: string; remote: string; content: string }> = [];
  created = false;
  destroyed = false;
  keyAdded = false;
  keyRemoved = false;
  proxyPublic = false;
  active = true;

  constructor() {
    super(async () => ({ stdout: "", stderr: "" }));
  }

  override async createVm(): Promise<ExeVm> {
    this.created = true;
    return {
      vmName: "maquila-controller",
      status: "running",
      sshDest: "maquila-controller.exe.xyz",
    };
  }

  override async exec(_destination: string, argv: string[]): Promise<ExecResult> {
    this.commands.push(argv);
    if (argv[0] === "uname") return { stdout: "x86_64\n", stderr: "" };
    if (argv[0] === "sha256sum") return { stdout: `${NODE_CHECKSUMS.x64}  archive\n`, stderr: "" };
    if (argv[0]?.endsWith("/bun") && argv[1] === "--version")
      return { stdout: "1.3.14\n", stderr: "" };
    if (argv[0] === "cat") return { stdout: `${PUBLIC_KEY}\n`, stderr: "" };
    if (argv[0] === "id") return { stdout: "1000\n", stderr: "" };
    if (argv.includes("systemctl") && argv.includes("--property=ActiveState"))
      return { stdout: this.active ? "active\n" : "inactive\n", stderr: "" };
    return { stdout: "", stderr: "" };
  }

  override async copyTo(
    _destination: string,
    localPath: string,
    remotePath: string,
  ): Promise<ExecResult> {
    this.copies.push({
      local: localPath,
      remote: remotePath,
      content: readFileSync(localPath, "utf8"),
    });
    return { stdout: "", stderr: "" };
  }

  override async addSshKey(publicKey: string): Promise<void> {
    assert.equal(publicKey, PUBLIC_KEY);
    this.keyAdded = true;
  }

  override async removeSshKey(publicKey: string): Promise<void> {
    assert.equal(publicKey, PUBLIC_KEY);
    this.keyRemoved = true;
  }

  override async configurePublicProxy(_vmName: string, port: number): Promise<void> {
    assert.equal(port, 8080);
    this.proxyPublic = true;
  }

  override async makeProxyPrivate(): Promise<void> {
    this.proxyPublic = false;
  }

  override async listVms(): Promise<ExeVm[]> {
    return this.destroyed
      ? []
      : [
          {
            vmName: "maquila-controller",
            status: "running",
            sshDest: "maquila-controller.exe.xyz",
          },
        ];
  }

  override async destroyVm(): Promise<{ destroyed: boolean; notFound: boolean }> {
    this.destroyed = true;
    return { destroyed: true, notFound: false };
  }
}

function fakePackage(directory: string): ControllerPackage {
  const path = join(directory, "maquila.tgz");
  writeFileSync(path, "package");
  return {
    path,
    sha256: "b".repeat(64),
    sourceSha: "a".repeat(40),
    sourceDirty: true,
    cleanup: () => undefined,
  };
}

const credentials = {
  linearToken: "linear-secret-value",
  githubToken: "github-secret-value",
  openRouterKey: "openrouter-secret-value",
};

const target = {
  path: "/tmp/target",
  owner: "santychuycom",
  repo: "santychuy.com",
  baseRef: "main",
  tag: "santychuycom-santychuy_com",
};

test("first-party intake deploy owns VM, key, proxy, webhook, and rollback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maquila-intake-controller-"));
  const statePath = join(directory, "state.json");
  const exe = new FakeExe();
  const deleted: string[] = [];
  try {
    const state = await deployIntakeController({
      codeRoot: directory,
      statePath,
      target,
      credentials,
      vmName: "maquila-controller",
      port: 8080,
      exe,
      package: fakePackage(directory),
      fetch: async () => new Response(null, { status: 404 }),
      sleep: async () => undefined,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      resolveTeamId: async () => "team-1",
      createWebhook: async (input) => {
        assert.equal(input.url, "https://maquila-controller.exe.xyz/hooks/linear");
        assert.match(input.secret, /^[0-9a-f]{64}$/);
        assert.equal(input.teamId, "team-1");
        return { id: "22222222-2222-4222-8222-222222222222" };
      },
      deleteWebhook: async (input) => {
        deleted.push(input.id);
      },
      listWebhooks: async () => [],
    });
    assert.equal(state.status, "running");
    assert.equal(exe.created, true);
    assert.equal(exe.keyAdded, true);
    assert.equal(exe.proxyPublic, true);
    assert.equal(state.bootPersistent, true);
    assert.ok(
      exe.commands.some((argv) => argv.join(" ").includes("sudo -n loginctl enable-linger exedev")),
    );
    assert.equal(readIntakeControllerState(statePath)?.linearWebhookId, state.linearWebhookId);
    const commandText = JSON.stringify(exe.commands);
    assert.doesNotMatch(commandText, /linear-secret|github-secret|openrouter-secret/);
    const environment = exe.copies.find((copy) => copy.remote.endsWith("intake.env"));
    assert.match(environment?.content ?? "", /LINEAR_API_TOKEN=/);
    assert.match(environment?.content ?? "", /MAQUILA_EXE_IDENTITY=/);
    assert.doesNotMatch(JSON.stringify(state), /linear-secret|github-secret|openrouter-secret/);

    const destroyed = await destroyIntakeController({
      statePath,
      credentials,
      exe,
      deleteWebhook: async (input) => {
        deleted.push(input.id);
      },
      now: () => Date.parse("2026-01-02T00:00:00.000Z"),
    });
    assert.equal(destroyed?.status, "destroyed");
    assert.equal(exe.destroyed, true);
    assert.equal(exe.keyRemoved, true);
    assert.equal(exe.proxyPublic, false);
    assert.ok(
      exe.commands.some((argv) => argv.join(" ").includes("systemctl --user disable --now")),
    );
    assert.ok(exe.commands.some((argv) => argv.includes("/home/exedev/.ssh/maquila-controller")));
    assert.deepEqual(deleted, ["22222222-2222-4222-8222-222222222222"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed service bootstrap revokes key and destroys new VM", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maquila-intake-controller-failure-"));
  const statePath = join(directory, "state.json");
  const exe = new FakeExe();
  exe.active = false;
  try {
    await assert.rejects(
      deployIntakeController({
        codeRoot: directory,
        statePath,
        target,
        credentials,
        vmName: "maquila-controller",
        port: 8080,
        exe,
        package: fakePackage(directory),
        fetch: async () => new Response(null, { status: 404 }),
        sleep: async () => undefined,
        listWebhooks: async () => [],
      }),
      /service health check \(inactive\)/,
    );
    assert.equal(exe.keyRemoved, true);
    assert.equal(exe.destroyed, true);
    assert.equal(readIntakeControllerState(statePath)?.status, "destroyed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
