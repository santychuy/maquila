import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { cliInvocation, factoryRoot, isMain } from "../src/runtime.js";

test("runtime paths support source, compiled JavaScript, and Bun executables", () => {
  const root = process.cwd();
  assert.equal(factoryRoot(resolve(root, "src")), root);
  assert.equal(factoryRoot(resolve(root, "dist/src")), root);
  assert.deepEqual(cliInvocation("/$bunfs/root/factory", ["--help"], "/factory/dist/factory"), {
    command: "/factory/dist/factory",
    args: ["--help"],
  });
  assert.deepEqual(cliInvocation("/factory/dist/src/cli.js", ["--help"], "/usr/bin/node"), {
    command: "/usr/bin/node",
    args: ["/factory/dist/src/cli.js", "--help"],
  });
  assert.equal(isMain("file:///$bunfs/root/factory", "/$bunfs/root/factory"), true);
});
