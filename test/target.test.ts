import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultGit, parseGitHubOrigin, resolveTargetRepository } from "../src/target.js";

test("GitHub origin parser accepts HTTPS and SSH forms", () => {
  assert.deepEqual(parseGitHubOrigin("https://github.com/acme/widget.git"), {
    owner: "acme",
    repo: "widget",
  });
  assert.deepEqual(parseGitHubOrigin("git@github.com:acme/widget.git"), {
    owner: "acme",
    repo: "widget",
  });
  assert.deepEqual(parseGitHubOrigin("ssh://git@github.com/acme/widget"), {
    owner: "acme",
    repo: "widget",
  });
});

test("target resolution infers immutable repository inputs and applies safe overrides", () => {
  const calls: string[] = [];
  const result = resolveTargetRepository({
    target: "/tmp/target",
    owner: "other",
    baseRef: "release",
    git: (_cwd, args) => {
      calls.push(args.join(" "));
      if (args[0] === "rev-parse") return "/tmp/target";
      if (args[0] === "remote") return "https://github.com/acme/widget.git";
      if (args[0] === "symbolic-ref") return "refs/remotes/origin/main";
      return args[2] ?? "";
    },
  });
  assert.deepEqual(result, {
    path: "/tmp/target",
    owner: "other",
    repo: "widget",
    baseRef: "release",
    tag: "other-widget",
  });
  assert.equal(calls.length, 4);

  const slash = resolveTargetRepository({
    target: "/tmp/target",
    baseRef: "release/2026-q1",
    git: (_cwd, args) => {
      if (args[0] === "rev-parse") return "/tmp/target";
      if (args[0] === "remote") return "https://github.com/acme/widget.git";
      if (args[0] === "symbolic-ref") return "refs/remotes/origin/main";
      return args[2] ?? "";
    },
  });
  assert.equal(slash.baseRef, "release/2026-q1");
});

test("default target Git inspection receives only operational environment", () => {
  let captured: NodeJS.ProcessEnv = {};
  const result = defaultGit(
    "/tmp/target",
    ["status"],
    {
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      LINEAR_API_TOKEN: "linear-secret",
      GITHUB_TOKEN: "github-secret",
      UNRELATED_SECRET: "other-secret",
    },
    (_file, _args, options) => {
      captured = options.env;
      return "clean\n";
    },
  );
  assert.equal(result, "clean");
  assert.equal(captured.PATH, "/usr/bin:/bin");
  assert.equal(captured.HOME, "/tmp/home");
  assert.equal(captured.LINEAR_API_TOKEN, undefined);
  assert.equal(captured.GITHUB_TOKEN, undefined);
  assert.equal(captured.UNRELATED_SECRET, undefined);
});

test("target resolution fails closed on unsupported or ambiguous inputs", () => {
  assert.throws(() => parseGitHubOrigin("https://gitlab.com/acme/widget.git"), /GitHub/);
  assert.throws(
    () =>
      resolveTargetRepository({
        target: "/tmp/target",
        git: (_cwd, args) => {
          if (args[0] === "rev-parse") return "/tmp/target";
          if (args[0] === "remote") return "https://github.com/acme/widget.git";
          return "";
        },
      }),
    /origin HEAD/,
  );
  assert.throws(() =>
    resolveTargetRepository({
      target: "/tmp/target",
      tag: "bad/tag",
      git: (_cwd, args) => {
        if (args[0] === "rev-parse") return "/tmp/target";
        if (args[0] === "remote") return "https://github.com/acme/widget.git";
        if (args[0] === "symbolic-ref") return "refs/remotes/origin/main";
        return args[2] ?? "";
      },
    }),
  );
});
