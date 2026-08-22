import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
        typeof reply.stderr === "string"
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
  assert.deepEqual(fake.calls[0]?.args.slice(-5), [
    "-i",
    "/tmp/maquila-key",
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
