import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { runDoctor, type DoctorOptions } from "../src/doctor.js";
import { fetchLinearIssue } from "../src/integrations/linear.js";
const MODELS = new Set(["google/gemini-3.7-flash", "z-ai/glm-5.3"]);
function options(root: string) {
  return {
    maquilaRoot: root,
    target: root,
    env: {},
    homedir: () => root,
    resolveTarget: () => ({
      path: root,
      owner: "acme",
      repo: "demo",
      baseRef: "main",
      tag: "acme-demo",
    }),
    resolveGithub: async () => "github-secret",
    resolveLinear: async () => "linear-secret",
    resolveOpenRouter: async () => "openrouter-secret",
    resolveModelIds: async () => MODELS,
    write: () => undefined,
  };
}
test("doctor uses target snapshot and exe list-only checks without secrets", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-"));
  try {
    mkdirSync(resolve(root, "dist"));
    writeFileSync(resolve(root, "dist/maquila"), "");
    let list = 0;
    const result = await runDoctor({
      ...options(root),
      fetchGithubSnapshot: async (value) => {
        assert.deepEqual(
          { owner: value.owner, repo: value.repo, baseRef: value.baseRef },
          { owner: "acme", repo: "demo", baseRef: "main" },
        );
      },
      listVms: async () => {
        list++;
        return [];
      },
    });
    assert.equal(list, 1);
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("doctor fails GitHub without target and still resolves credentials after invalid config", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-"));
  try {
    let snapshot = 0,
      linearConfig: unknown;
    const result = await runDoctor({
      ...options(root),
      loadConfig: () => {
        throw new Error("bad");
      },
      resolveTarget: () => {
        throw new Error("bad");
      },
      resolveLinear: async (_env, config) => {
        linearConfig = config;
        return "linear";
      },
      fetchGithubSnapshot: async () => {
        snapshot++;
      },
      listVms: async () => [],
    });
    assert.equal(snapshot, 0);
    assert.equal(linearConfig, undefined);
    assert.equal(result.checks.find((item) => item.id === "github")?.status, "fail");
    assert.equal(result.checks.find((item) => item.id === "linear")?.status, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("doctor identity flag overrides environment identity", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-"));
  try {
    const identities: Array<string | undefined> = [];
    await runDoctor({
      ...options(root),
      env: { MAQUILA_EXE_IDENTITY: "/env/key" },
      identity: "/flag/key",
      fetchGithubSnapshot: async () => ({}),
      listVms: async (identity) => {
        identities.push(identity);
        return [];
      },
    });
    await runDoctor({
      ...options(root),
      env: { MAQUILA_EXE_IDENTITY: "/env/key" },
      fetchGithubSnapshot: async () => ({}),
      listVms: async (identity) => {
        identities.push(identity);
        return [];
      },
    });
    assert.deepEqual(identities, ["/flag/key", "/env/key"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor rejects an invalid environment identity before SSH", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-"));
  try {
    let called = false;
    const result = await runDoctor({
      ...options(root),
      env: { MAQUILA_EXE_IDENTITY: "relative-key" },
      fetchGithubSnapshot: async () => ({}),
      listVms: async () => {
        called = true;
        return [];
      },
    });
    assert.equal(called, false);
    assert.equal(result.checks.find((item) => item.id === "ssh")?.status, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor issue preflight enforces exact label and reports no secret", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-"));
  try {
    const result = await runDoctor({
      ...options(root),
      issue: "RIFF-1",
      requireLabel: "maquila-ready",
      fetchLinearIssue: async ({ token, issue }) => {
        assert.equal(token, "linear-secret");
        assert.equal(issue, "RIFF-1");
        return {
          uuid: "u",
          identifier: issue,
          title: "t",
          description: "d",
          url: "u",
          assignee: { id: "a", name: "n", url: "u" },
          team: { id: "t", name: "t", key: "T" },
          state: { id: "s", name: "Todo", type: "unstarted" },
          labels: [{ id: "l", name: "maquila-ready" }],
          snapshotSha256: "h",
        };
      },
      fetchGithubSnapshot: async () => ({}),
      listVms: async () => [],
    });
    assert.equal(result.checks.find((c) => c.id === "issue")?.status, "pass");
    assert.equal(JSON.stringify(result).includes("linear-secret"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor issue preflight is optional and skips Linear fetch without credential", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-"));
  try {
    let fetched = false;
    const result = await runDoctor({
      ...options(root),
      issue: "RIFF-2",
      resolveLinear: async () => {
        throw new Error("missing");
      },
      fetchLinearIssue: async () => {
        fetched = true;
        throw new Error("must not call");
      },
      fetchGithubSnapshot: async () => ({}),
      listVms: async () => [],
    });
    assert.equal(fetched, false);
    assert.equal(result.checks.find((c) => c.id === "issue")?.status, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("doctor issue preflight fails absent or wrong-case required label", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-"));
  try {
    const base = {
      ...options(root),
      fetchLinearIssue: async () => ({
        uuid: "u",
        identifier: "RIFF-3",
        title: "t",
        description: "d",
        url: "u",
        assignee: { id: "a", name: "n", url: "u" },
        team: { id: "t", name: "t", key: "T" },
        state: { id: "s", name: "Todo", type: "unstarted" },
        labels: [{ id: "l", name: "MaQuIlA-READY" }],
        snapshotSha256: "h",
      }),
      fetchGithubSnapshot: async () => ({}),
      listVms: async () => [],
    };
    const result = await runDoctor({ ...base, issue: "RIFF-3", requireLabel: "maquila-ready" });
    assert.equal(result.checks.find((c) => c.id === "issue")?.status, "fail");
    assert.equal(JSON.stringify(result).includes("maquila-ready"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("doctor issue preflight fails when required label is absent", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-"));
  try {
    const result = await runDoctor({
      ...options(root),
      issue: "RIFF-5",
      requireLabel: "maquila-ready",
      fetchLinearIssue: async () => ({
        uuid: "u",
        identifier: "RIFF-5",
        title: "t",
        description: "d",
        url: "u",
        assignee: { id: "a", name: "n", url: "u" },
        team: { id: "t", name: "t", key: "T" },
        state: { id: "s", name: "Todo", type: "unstarted" },
        labels: [],
        snapshotSha256: "h",
      }),
      fetchGithubSnapshot: async () => ({}),
      listVms: async () => [],
    });
    assert.equal(result.checks.find((c) => c.id === "issue")?.status, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("doctor does not leak failed API error or credentials", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-"));
  try {
    let output = "";
    const result = await runDoctor({
      ...options(root),
      issue: "RIFF-4",
      requireLabel: "maquila-ready",
      fetchLinearIssue: async () => {
        throw new Error("linear-secret-token");
      },
      fetchGithubSnapshot: async () => ({}),
      listVms: async () => [],
      write: (text) => {
        output += text;
      },
    });
    assert.equal(result.checks.find((c) => c.id === "issue")?.status, "fail");
    assert.equal(JSON.stringify(result).includes("linear-secret-token"), false);
    assert.equal(output.includes("linear-secret-token"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor JSON output redacts failed API errors", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-"));
  try {
    let output = "";
    await runDoctor({
      ...options(root),
      json: true,
      issue: "RIFF-6",
      fetchLinearIssue: async () => {
        throw new Error("sentinel-api-secret");
      },
      fetchGithubSnapshot: async () => ({}),
      listVms: async () => [],
      write: (text) => {
        output += text;
      },
    });
    assert.equal(output.includes("sentinel-api-secret"), false);
    assert.equal(
      JSON.parse(output).checks.find((c: { id: string }) => c.id === "issue").message,
      "Linear issue access or assigned Todo eligibility could not be verified",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic doctor does not fetch an issue", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-generic-"));
  try {
    let fetched = false;
    const result = await runDoctor({
      ...options(root),
      fetchGithubSnapshot: async () => ({}),
      listVms: async () => [],
      fetchLinearIssue: async () => {
        fetched = true;
        throw new Error("must not fetch");
      },
    });
    assert.equal(fetched, false);
    assert.equal(
      result.checks.some((item) => item.id === "issue"),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor rejects invalid issue preflight options before any environment probe", async () => {
  let probes = 0;
  const invalid: Pick<DoctorOptions, "issue" | "requireLabel">[] = [
    { requireLabel: "maquila-ready" },
    ...["", " ", " RIFF-1", "RIFF-1 ", "RIFF-1\n", "a".repeat(129)].map((issue) => ({ issue })),
    ...["", " ", " maquila-ready", "maquila-ready\t", "a".repeat(129)].map((requireLabel) => ({
      issue: "RIFF-1",
      requireLabel,
    })),
  ];
  for (const value of invalid) {
    await assert.rejects(
      runDoctor({
        ...options("/unused"),
        ...value,
        loadConfig: () => {
          probes++;
          throw new Error("must not probe");
        },
        resolveTarget: () => {
          probes++;
          throw new Error("must not probe");
        },
        resolveGithub: async () => {
          probes++;
          return "unused";
        },
        resolveLinear: async () => {
          probes++;
          return "unused";
        },
        resolveOpenRouter: async () => {
          probes++;
          return "unused";
        },
        resolveModelIds: async () => {
          probes++;
          return MODELS;
        },
        fetchGithubSnapshot: async () => {
          probes++;
        },
        listVms: async () => {
          probes++;
          return [];
        },
      }),
      /--issue|--require-label/,
    );
  }
  assert.equal(probes, 0);
});

test("doctor uses the strict intake validator for assigned Todo eligibility", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "maquila-doctor-intake-"));
  try {
    const issue = {
      id: "fixture-id",
      identifier: "RIFF-1",
      title: "Fixture",
      description: "Small change",
      url: "https://linear.app/example/issue/RIFF-1",
      assignee: {
        id: "engineer",
        name: "Engineer",
        url: "https://linear.app/example/profiles/engineer",
      },
      team: { id: "team", name: "Team", key: "RIFF" },
      state: { id: "todo", name: "Todo", type: "unstarted" },
      project: null,
      labels: { nodes: [{ id: "label", name: "maquila-ready" }] },
    };
    for (const [snapshot, expected] of [
      [issue, "pass"],
      [{ ...issue, assignee: null }, "fail"],
      [{ ...issue, state: { id: "progress", name: "In Progress", type: "started" } }, "fail"],
      [{ ...issue, state: { id: "backlog", name: "Backlog", type: "unstarted" } }, "fail"],
    ] as const) {
      let reads = 0;
      const result = await runDoctor({
        ...options(root),
        issue: "RIFF-1",
        requireLabel: "maquila-ready",
        fetchGithubSnapshot: async () => ({}),
        listVms: async () => [],
        fetchLinearIssue: (request) =>
          fetchLinearIssue({
            ...request,
            fetch: async (_url, init) => {
              reads++;
              const body = init?.body;
              assert.ok(typeof body === "string");
              assert.match(body, /query/);
              assert.doesNotMatch(body, /mutation/);
              return new Response(JSON.stringify({ data: { issue: snapshot } }), { status: 200 });
            },
          }),
      });
      assert.equal(reads, 1);
      assert.equal(result.checks.find((item) => item.id === "issue")?.status, expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
