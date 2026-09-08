import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { cliInvocation, maquilaRoot, hostStateRoot, isMain } from "../src/runtime.js";

test("runtime paths support source, compiled JavaScript, and Bun executables", () => {
  const root = process.cwd();
  assert.equal(maquilaRoot(resolve(root, "src")), root);
  assert.equal(maquilaRoot(resolve(root, "dist/src")), root);
  assert.equal(maquilaRoot(resolve(root, "src/observer")), root);
  assert.equal(maquilaRoot(resolve(root, "dist/src/observer")), root);
  assert.equal(maquilaRoot(resolve(root, "dist/src/observer", "..")), root);
  assert.deepEqual(cliInvocation("/$bunfs/root/maquila", ["--help"], "/maquila/dist/maquila"), {
    command: "/maquila/dist/maquila",
    args: ["--help"],
  });
  assert.deepEqual(cliInvocation("/maquila/dist/src/cli.js", ["--help"], "/usr/bin/node"), {
    command: "/usr/bin/node",
    args: ["/maquila/dist/src/cli.js", "--help"],
  });
  assert.equal(isMain("file:///$bunfs/root/maquila", "/$bunfs/root/maquila"), true);
});

test("host state routing preserves checkout and isolates installed homes", () => {
  const root = process.cwd();
  assert.equal(hostStateRoot(root, {}), root);
  assert.equal(
    hostStateRoot("/opt/maquila", { XDG_STATE_HOME: "/tmp/state" }),
    "/tmp/state/maquila",
  );
  assert.equal(hostStateRoot("/opt/maquila", { MAQUILA_HOME: "/tmp/a" }), "/tmp/a");
  assert.throws(() => hostStateRoot("/opt/maquila", { MAQUILA_HOME: " relative" }), /MAQUILA_HOME/);
  assert.throws(() => hostStateRoot("/opt/maquila", { MAQUILA_HOME: "/tmp/a/" }), /MAQUILA_HOME/);
  assert.throws(
    () => hostStateRoot("/opt/maquila", { XDG_STATE_HOME: "relative" }),
    /XDG_STATE_HOME/,
  );
});
