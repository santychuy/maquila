import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyExeCreateRejection,
  ExeClient,
  ExeCommandError,
  externalCommandEnvironment,
  quoteRemoteArg,
  sshCommandEnvironment,
  type ExeRunner,
  type ExeStreamRunner,
  type ExecResult,
} from "../src/integrations/exe.js";

interface Call {
  file: string;
  args: string[];
  timeout: number;
  env: NodeJS.ProcessEnv;
}

function runner(replies: Array<ExecResult | Error | Record<string, unknown>>): {
  run: ExeRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    run: async (file, args, options) => {
      calls.push({ file, args, timeout: options.timeout, env: options.env });
      const reply = replies.shift();
      if (!reply) throw new Error("unexpected exe.dev call");
      if (
        !(reply instanceof Error) &&
        typeof reply.stdout === "string" &&
        typeof reply.stderr === "string" &&
        typeof (reply as Record<string, unknown>).code !== "number" &&
        typeof (reply as Record<string, unknown>).status !== "number" &&
        (reply as Record<string, unknown>).killed !== true
      ) {
        return { stdout: reply.stdout, stderr: reply.stderr };
      }
      throw reply;
    },
  };
}

const stream: ExeStreamRunner = async (_file, _args, _options, onStdout) => {
  onStdout(Buffer.from("one"));
  onStdout(Buffer.from("two"));
  return { stderr: "" };
};

const vm = {
  vm_name: "maquila-run-1",
  status: "running",
  ssh_dest: "maquila-run-1.exe.xyz",
  ssh_host: "maquila-run-1.exe.xyz",
};

test("create VM uses fixed image, safe tag, and validates response", async () => {
  const fake = runner([{ stdout: JSON.stringify({ ...vm, status: undefined }), stderr: "" }]);
  const client = new ExeClient(fake.run, 12_345);
  const created = await client.createVm({
    name: "maquila-run-1",
    tag: "santychuy-bookbounce",
  });
  assert.equal(created.sshDest, "maquila-run-1.exe.xyz");
  assert.equal(created.status, "creating");
  assert.equal(fake.calls[0]?.file, "ssh");
  assert.ok(fake.calls[0]?.args.includes("--image=exeuntu"));
  assert.ok(fake.calls[0]?.args.includes("--tag=santychuy-bookbounce"));
  assert.ok(fake.calls[0]?.args.includes("BatchMode=yes"));
  assert.equal(fake.calls[0]?.timeout, 12_345);
});

test("controller key and public proxy commands stay strict", async () => {
  const fake = runner([
    { stdout: "{}", stderr: "" },
    { stdout: "{}", stderr: "" },
    { stdout: "{}", stderr: "" },
    { stdout: "{}", stderr: "" },
    { stdout: "{}", stderr: "" },
  ]);
  const client = new ExeClient(fake.run);
  const publicKey = `ssh-ed25519 ${"A".repeat(68)} maquila-controller`;
  await client.addSshKey(publicKey, "maquila-controller");
  await client.configurePublicProxy("maquila-controller", 8080);
  await client.makeProxyPrivate("maquila-controller");
  await client.removeSshKey(publicKey);
  assert.deepEqual(fake.calls[0]?.args.slice(-6), [
    "exe.dev",
    "ssh-key",
    "add",
    "--tag=maquila-controller",
    `'${publicKey}'`,
    "--json",
  ]);
  assert.deepEqual(fake.calls[1]?.args.slice(-5), [
    "share",
    "port",
    "maquila-controller",
    "8080",
    "--json",
  ]);
  assert.deepEqual(fake.calls[2]?.args.slice(-4), [
    "share",
    "set-public",
    "maquila-controller",
    "--json",
  ]);
  assert.deepEqual(fake.calls[3]?.args.slice(-4), [
    "share",
    "set-private",
    "maquila-controller",
    "--json",
  ]);
  assert.deepEqual(fake.calls[4]?.args.slice(-5), [
    "exe.dev",
    "ssh-key",
    "remove",
    `'${publicKey}'`,
    "--json",
  ]);
  await assert.rejects(() => client.addSshKey("unsafe", "maquila-controller"), /invalid/);
  await assert.rejects(() => client.configurePublicProxy("unsafe name", 8080), /invalid/);
});

test("controller SSH key lookup ignores stored comments", async () => {
  const publicKey = `ssh-ed25519 ${"A".repeat(68)} maquila-controller`;
  const fake = runner([
    {
      stdout: JSON.stringify({
        ssh_keys: [{ public_key: publicKey.split(" ").slice(0, 2).join(" ") }],
      }),
      stderr: "",
    },
  ]);
  assert.equal(await new ExeClient(fake.run).hasSshKey(publicKey), true);
});

test("controller can revoke its key and self-destruct over one authenticated connection", async () => {
  const publicKey = `ssh-ed25519 ${"A".repeat(68)} maquila-controller`;
  const fake = runner([
    { stdout: "", stderr: "" },
    { stdout: "{}", stderr: "" },
    { stdout: "{}", stderr: "" },
    { stdout: "", stderr: "" },
  ]);
  await new ExeClient(fake.run, 30_000, "/tmp/maquila-key").destroyVmFromWithin(
    "maquila-controller",
    publicKey,
  );
  const socket = fake.calls[0]?.args[fake.calls[0].args.indexOf("-S") + 1];
  assert.match(socket ?? "", /^\/tmp\/maquila-exe-/);
  assert.ok(fake.calls[0]?.args.includes("-M"));
  assert.ok(fake.calls[0]?.args.includes("-fN"));
  assert.deepEqual(fake.calls[1]?.args.slice(-5), [
    "exe.dev",
    "ssh-key",
    "remove",
    `'${publicKey}'`,
    "--json",
  ]);
  assert.deepEqual(fake.calls[2]?.args.slice(-4), [
    "exe.dev",
    "rm",
    "maquila-controller",
    "--json",
  ]);
  assert.ok(fake.calls[3]?.args.includes("exit"));
});

test("failed self-destruction restores controller key for timer retry", async () => {
  const publicKey = `ssh-ed25519 ${"A".repeat(68)} maquila-controller`;
  const fake = runner([
    { stdout: "", stderr: "" },
    { stdout: "{}", stderr: "" },
    new Error("destroy failed"),
    { stdout: "{}", stderr: "" },
    { stdout: "", stderr: "" },
  ]);
  await assert.rejects(
    () =>
      new ExeClient(fake.run, 30_000, "/tmp/maquila-key").destroyVmFromWithin(
        "maquila-controller",
        publicKey,
      ),
    /destroy controller VM failed/,
  );
  assert.ok(fake.calls[3]?.args.includes("add"));
  assert.ok(fake.calls[3]?.args.includes("--tag=maquila-controller"));
});

test("identity-less client uses OpenSSH defaults without agent forwarding", async () => {
  const fake = runner([{ stdout: JSON.stringify({ vms: [] }), stderr: "" }]);
  await new ExeClient(fake.run, 30_000).listVms();
  assert.equal(fake.calls[0]?.args.includes("-i"), false);
  assert.equal(fake.calls[0]?.args.includes("-A"), false);
  assert.ok(fake.calls[0]?.args.includes("BatchMode=yes"));
});

test("dedicated SSH identity supports unattended commands", async () => {
  const fake = runner([{ stdout: JSON.stringify({ vms: [] }), stderr: "" }]);
  await new ExeClient(fake.run, 30_000, "/tmp/maquila-key").listVms();
  assert.ok(fake.calls[0]?.args.includes("IdentitiesOnly=yes"));
  assert.deepEqual(fake.calls[0]?.args.slice(-6), [
    "-i",
    "/tmp/maquila-key",
    "-n",
    "exe.dev",
    "ls",
    "--json",
  ]);
  assert.throws(() => new ExeClient(fake.run, 30_000, "relative-key"), /local path/);
});

test("external commands receive only operational environment", async () => {
  const fake = runner([{ stdout: JSON.stringify({ vms: [] }), stderr: "" }]);
  await new ExeClient(fake.run, 30_000, "/tmp/maquila-key", stream, {
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/home",
    LANG: "C.UTF-8",
    LINEAR_API_TOKEN: "linear-secret",
    GITHUB_TOKEN: "github-secret",
    UNRELATED_SECRET: "other-secret",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
  }).listVms();
  assert.deepEqual(fake.calls[0]?.env, {
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/home",
    LANG: "C.UTF-8",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
  });
  assert.equal(fake.calls[0]?.args.includes("-A"), false);
  assert.ok(fake.calls[0]?.args.includes("StrictHostKeyChecking=yes"));
  assert.ok(fake.calls[0]?.args.includes("UpdateHostKeys=no"));
  assert.deepEqual(
    fake.calls[0]?.args.slice(
      fake.calls[0].args.indexOf("ForwardAgent=no") - 1,
      fake.calls[0].args.indexOf("ForwardAgent=no") + 1,
    ),
    ["-o", "ForwardAgent=no"],
  );
  assert.deepEqual(
    externalCommandEnvironment({
      PATH: "/usr/bin:/bin",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      LINEAR_API_TOKEN: "linear-secret",
    }),
    { PATH: "/usr/bin:/bin" },
  );
  assert.equal(
    sshCommandEnvironment({ PATH: "/bin", SSH_AUTH_SOCK: "/tmp/agent.sock" }).SSH_AUTH_SOCK,
    "/tmp/agent.sock",
  );
  assert.throws(
    () => sshCommandEnvironment({ SSH_AUTH_SOCK: "bad\0sock" }),
    /SSH_AUTH_SOCK is invalid/,
  );
  assert.throws(() => sshCommandEnvironment({ SSH_AUTH_SOCK: "   " }), /SSH_AUTH_SOCK is invalid/);
});

test("create and list reject malformed JSON and VM identity", async () => {
  await assert.rejects(
    () =>
      new ExeClient(runner([{ stdout: "not-json", stderr: "" }]).run).createVm({
        name: "vm-1",
        tag: "tag-1",
      }),
    /invalid exe.dev JSON/,
  );
  await assert.rejects(
    () =>
      new ExeClient(
        runner([{ stdout: JSON.stringify({ ...vm, vm_name: "other" }), stderr: "" }]).run,
      ).createVm({ name: "vm-1", tag: "tag-1" }),
    /unexpected VM/,
  );
  await assert.rejects(
    () =>
      new ExeClient(runner([{ stdout: JSON.stringify({ vms: [{}] }), stderr: "" }]).run).listVms(),
    /VM name must be non-blank/,
  );
});

test("remote argv is shell-quoted as data", async () => {
  const fake = runner([{ stdout: "ok", stderr: "" }]);
  const client = new ExeClient(fake.run);
  await client.exec("vm+maquila@vm.exe.xyz", ["printf", "%s", "a;$(touch /tmp/nope)'b"]);
  const command = fake.calls[0]?.args.at(-1) ?? "";
  assert.equal(command, `'printf' '%s' 'a;$(touch /tmp/nope)'\\''b'`);
  assert.equal(fake.calls[0]?.args.at(-2), "vm+maquila@vm.exe.xyz");
  assert.equal(quoteRemoteArg(""), "''");
  assert.throws(() => quoteRemoteArg("bad\0arg"), /NUL/);
});

test("remote streaming forwards chunks without buffering stdout", async () => {
  const chunks: string[] = [];
  const client = new ExeClient(runner([]).run, 30_000, undefined, stream);
  await client.execStream("vm.exe.xyz", ["echo", "ok"], (chunk) => chunks.push(chunk.toString()));
  assert.deepEqual(chunks, ["one", "two"]);
});

test("copy operations require safe absolute paths", async () => {
  const fake = runner([
    { stdout: "", stderr: "" },
    { stdout: "", stderr: "" },
  ]);
  const client = new ExeClient(fake.run);
  await client.copyTo("vm.exe.xyz", "/tmp/input.tar", "/tmp/input.tar");
  await client.copyFrom("vm.exe.xyz", "/tmp/output.tar", "/tmp/output.tar");
  assert.equal(fake.calls[0]?.file, "scp");
  assert.ok(fake.calls[0]?.args.includes("vm.exe.xyz:/tmp/input.tar"));
  assert.ok(fake.calls[1]?.args.includes("vm.exe.xyz:/tmp/output.tar"));
  await assert.rejects(() => client.copyTo("vm.exe.xyz", "relative", "/tmp/x"), /local path/);
  await assert.rejects(
    () => client.copyFrom("vm.exe.xyz", "/tmp/../secret", "/tmp/x"),
    /remote path/,
  );
});

test("command failures are structured and redact runner details", async () => {
  const fake = runner([{ killed: true, code: "ETIMEDOUT", stderr: "secret-output" }]);
  const client = new ExeClient(fake.run);
  await assert.rejects(
    () => client.exec("vm.exe.xyz", ["sleep", "10"]),
    (error) =>
      error instanceof ExeCommandError &&
      error.operation === "remote command" &&
      error.timedOut &&
      error.exitCode === null &&
      !error.message.includes("secret-output"),
  );
});

test("create VM failure carries allowlisted reason without raw provider output", async () => {
  const secret = "linear-secret-value";
  const fake = runner([{ code: 1, stderr: `invalid tag rejected plus ${secret}` }]);
  const client = new ExeClient(fake.run);
  await assert.rejects(
    () => client.createVm({ name: "vm-1", tag: "tag-1" }),
    (error) => {
      assert.ok(error instanceof ExeCommandError);
      assert.equal(error.reason, "invalid-tag");
      assert.equal(error.exitCode, 1);
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.message.includes("invalid tag"));
      return true;
    },
  );
  assert.equal(classifyExeCreateRejection("unknown image name"), "unknown-image");
  assert.equal(classifyExeCreateRejection("VM already exists"), "name-taken");
  assert.equal(classifyExeCreateRejection("quota exceeded"), "quota-exceeded");
  assert.equal(classifyExeCreateRejection("pool required"), "team-pool-required");
  assert.equal(classifyExeCreateRejection("missing integration"), "integration-required");
  assert.equal(
    classifyExeCreateRejection("some opaque provider text"),
    "unclassified-create-rejection",
  );
  assert.equal(classifyExeCreateRejection(undefined), "unclassified-create-rejection");
});

test("create VM detail preserves bounded provider text without leaking secrets", async () => {
  const secret = `known-secret-${Date.now()}`;
  const fake = runner([
    { code: 1, stderr: `image rejected\n\u001b[31mboom\u001b[0m plus ${secret}` },
  ]);
  const client = new ExeClient(fake.run);
  const error = await client.createVm({ name: "vm-1", tag: "tag-1" }).then(
    () => assert.fail("expected create failure"),
    (caught: unknown) => {
      assert.ok(caught instanceof ExeCommandError);
      return caught;
    },
  );
  assert.equal(error.reason, "unknown-image");
  assert.ok(error.detail?.includes("boom"));
  assert.ok(!error.detail?.includes("\u001b") && !error.detail?.includes("\n"));
  assert.ok(!error.message.includes(secret) && !error.message.includes("boom"));
  assert.ok(!JSON.stringify(error).includes(secret));
  assert.ok(!JSON.stringify(error).includes("boom"));
  const { sanitizeTelemetryText } = await import("../src/telemetry.js");
  assert.ok(!sanitizeTelemetryText(error.detail ?? "", [secret]).includes(secret));
  // Redact-before-truncate: secret straddling truncation boundary must vanish, not clip.
  const long = `x`.repeat(990) + secret + `y`.repeat(50);
  assert.ok(!sanitizeTelemetryText(long, [secret]).includes(secret));
});

test("create VM falls back to strict stdout JSON message, non-create stays opaque", async () => {
  const stdoutClient = new ExeClient(
    runner([
      {
        code: 1,
        stderr: "",
        stdout: JSON.stringify({ message: "tag bad", extra: `z`.repeat(5000) }),
      },
    ]).run,
  );
  const stdoutError = await stdoutClient.createVm({ name: "vm-1", tag: "tag-1" }).then(
    () => assert.fail("expected create failure"),
    (caught: unknown) => {
      assert.ok(caught instanceof ExeCommandError);
      return caught;
    },
  );
  assert.equal(stdoutError.reason, "unclassified-create-rejection");
  assert.ok(stdoutError.detail?.includes("tag bad"));
  assert.ok(!(stdoutError.detail ?? "").includes("zzz"));
  // Whole non-JSON stdout never becomes detail.
  const dumpClient = new ExeClient(
    runner([{ code: 1, stderr: "", stdout: "plain success-shaped dump" }]).run,
  );
  const dumpError = await dumpClient.createVm({ name: "vm-1", tag: "tag-1" }).then(
    () => assert.fail("expected create failure"),
    (caught: unknown) => {
      assert.ok(caught instanceof ExeCommandError);
      return caught;
    },
  );
  assert.equal(dumpError.detail, undefined);
  // Non-create ops keep old opaque behavior: no reason, no detail.
  const other = new ExeClient(runner([{ killed: false, code: 1, stderr: "tag invalid" }]).run);
  await assert.rejects(
    () => other.exec("vm.exe.xyz", ["true"]),
    (error) => {
      assert.ok(error instanceof ExeCommandError);
      assert.equal(error.reason, undefined);
      assert.equal(error.detail, undefined);
      return true;
    },
  );
  // Buffer stderr classifies instead of mapping to unclassified.
  assert.equal(classifyExeCreateRejection(Buffer.from("unknown image name")), "unknown-image");
});

test("destroy is retry-safe when VM is already absent", async () => {
  const fake = runner([
    { stdout: JSON.stringify({ vms: [vm] }), stderr: "" },
    { stdout: JSON.stringify({ removed: [vm.vm_name] }), stderr: "" },
    { stdout: JSON.stringify({ vms: [] }), stderr: "" },
  ]);
  const client = new ExeClient(fake.run);
  assert.deepEqual(await client.destroyVm(vm.vm_name), { destroyed: true, notFound: false });
  assert.deepEqual(await client.destroyVm(vm.vm_name), { destroyed: false, notFound: true });
  assert.ok(fake.calls[1]?.args.includes("rm"));
  assert.ok(fake.calls[1]?.args.includes(vm.vm_name));
});

test("explicit invalid exe tag is rejected before SSH", async () => {
  const fake = runner([]);
  const client = new ExeClient(fake.run);
  await assert.rejects(
    () => client.createVm({ name: "vm-1", tag: "Bad.Tag" }),
    /exe\.dev tags must match/,
  );
  await assert.rejects(
    () => client.createVm({ name: "vm-1", tag: "1abc" }),
    /exe\.dev tags must match/,
  );
  assert.equal(fake.calls.length, 0);
});

test("unsafe VM control inputs fail before runner", async () => {
  const fake = runner([]);
  const client = new ExeClient(fake.run);
  await assert.rejects(() => client.createVm({ name: "bad;name", tag: "tag" }), /invalid VM name/);
  await assert.rejects(
    () => client.createVm({ name: "vm", tag: "tag", integration: "bad value" }),
    /invalid integration/,
  );
  await assert.rejects(() => client.exec("bad host", ["true"]), /SSH destination/);
  await assert.rejects(() => client.exec("-oProxyCommand=bad", ["true"]), /SSH destination/);
  await assert.rejects(() => client.exec("-o@host.exe.xyz", ["true"]), /SSH destination/);
  await assert.rejects(
    () => client.copyTo("-o@host.exe.xyz", "/tmp/x", "/tmp/x"),
    /SSH destination/,
  );
  await assert.rejects(() => client.exec("vm.exe.xyz", ["true"], 0), /positive integer/);
  assert.equal(fake.calls.length, 0);
});
