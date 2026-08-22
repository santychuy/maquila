import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { cliInvocation, maquilaRoot, isMain } from "../src/runtime.js";

test("runtime paths support source, compiled JavaScript, and Bun executables", () => {
  const root = process.cwd();
  assert.equal(maquilaRoot(resolve(root, "src")), root);
  assert.equal(maquilaRoot(resolve(root, "dist/src")), root);
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
