import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createTelemetryWriter,
  MAX_TELEMETRY_FILE_BYTES,
  parseTelemetryRecord,
  readTelemetry,
  sanitizeTelemetryText,
  telemetryPath,
} from "../src/telemetry.js";

const runId = "11111111-1111-1111-1111-111111111111";

function record(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    runId,
    seq: 1,
    eventId: `${runId}:1`,
    type: "run_created",
    recordedAt: new Date(0).toISOString(),
    actor: "controller",
    payload: { status: "created" },
    ...overrides,
  };
}

test("telemetry schema rejects unknown fields and inconsistent identity", () => {
  assert.throws(() => parseTelemetryRecord(record({ secret: "nope" })), /invalid telemetry/);
  assert.throws(() => parseTelemetryRecord(record({ eventId: `${runId}:2` })), /eventId/);
  assert.throws(
    () =>
      parseTelemetryRecord(
        record({ type: "tool_started", payload: { toolName: "bash", toolCallId: "1", args: [] } }),
      ),
    /invalid telemetry/,
  );
  assert.throws(
    () =>
      parseTelemetryRecord(
        record({ type: "phase_finished", actor: "planner", payload: { status: "completed" } }),
      ),
    /requires phase/,
  );
  assert.throws(
    () => parseTelemetryRecord(record({ type: "agent_started", actor: "planner", payload: {} })),
    /requires phase/,
  );
  assert.throws(
    () =>
      parseTelemetryRecord(
        record({
          type: "tool_started",
          actor: "worker",
          payload: { toolName: "edit", toolCallId: "1" },
        }),
      ),
    /requires phase/,
  );
  for (const value of [
    {
      type: "agent_content",
      actor: "planner",
      payload: {
        contentId: "content-1",
        kind: "user_prompt",
        chunkIndex: 0,
        chunkCount: 1,
        text: "prompt",
      },
    },
    {
      type: "agent_content_unavailable",
      actor: "planner",
      payload: { contentId: "content-1", kind: "reasoning", reason: "provider_redacted" },
    },
  ])
    assert.throws(() => parseTelemetryRecord(record(value)), /requires phase/);
});

test("telemetry agent content enforces UTF-8 bytes and chunk indexes", () => {
  const content = {
    type: "agent_content",
    actor: "planner",
    phase: { id: "plan:1", name: "planning", stepId: "plan", attempt: 1 },
    payload: {
      contentId: "content-1",
      kind: "user_prompt",
      chunkIndex: 0,
      chunkCount: 1,
      text: "prompt",
    },
  };
  assert.throws(
    () =>
      parseTelemetryRecord(
        record({
          ...content,
          payload: { ...content.payload, text: "🙂".repeat(3_000) },
        }),
      ),
    /byte limit/,
  );
  assert.throws(
    () =>
      parseTelemetryRecord(
        record({
          ...content,
          payload: { ...content.payload, chunkIndex: 1 },
        }),
      ),
    /chunk index/,
  );
});

test("telemetry accepts legacy phases and strictly validates new workflow steps", () => {
  assert.doesNotThrow(() =>
    parseTelemetryRecord(
      record({
        type: "phase_started",
        actor: "planner",
        phase: { id: "planning:1", name: "planning", attempt: 1 },
        payload: {},
      }),
    ),
  );
  assert.doesNotThrow(() =>
    parseTelemetryRecord(
      record({
        type: "phase_started",
        actor: "planner",
        phase: { id: "plan:1", name: "planning", stepId: "plan", attempt: 1 },
        payload: {},
      }),
    ),
  );
  for (const phase of [
    { id: "plan:1", name: "implementing", stepId: "plan", attempt: 1 },
    { id: "plan:1", name: "planning", stepId: "unknown", attempt: 1 },
  ])
    assert.throws(
      () =>
        parseTelemetryRecord(
          record({ type: "phase_started", actor: "planner", phase, payload: {} }),
        ),
      /invalid telemetry|step identity/,
    );
});

test("full telemetry replay preserves legacy agent ledgers without context or usage", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-telemetry-legacy-"));
  try {
    const path = createTelemetryWriter(root, runId).path;
    const phase = { id: "planning:1", name: "planning", attempt: 1 };
    const inputs = [
      { type: "run_created", actor: "controller", payload: { status: "created" } },
      { type: "phase_started", actor: "planner", phase, payload: {} },
      { type: "agent_started", actor: "planner", phase, payload: {} },
      {
        type: "tool_started",
        actor: "planner",
        phase,
        payload: { toolName: "read", toolCallId: "tool-1" },
      },
      {
        type: "tool_finished",
        actor: "planner",
        phase,
        payload: { toolName: "read", toolCallId: "tool-1", isError: false },
      },
      { type: "agent_finished", actor: "planner", phase, payload: { status: "completed" } },
      { type: "phase_finished", actor: "planner", phase, payload: { status: "completed" } },
    ];
    writeFileSync(
      path,
      inputs
        .map((input, index) =>
          JSON.stringify(
            record({
              ...input,
              seq: index + 1,
              eventId: `${runId}:${index + 1}`,
            }),
          ),
        )
        .join("\n") + "\n",
    );
    assert.equal(readTelemetry(path).length, inputs.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("telemetry replay rejects events interleaved between content chunks", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-telemetry-content-order-"));
  try {
    const path = createTelemetryWriter(root, runId).path;
    const phase = { id: "planning:1", name: "planning", attempt: 1 };
    const before = [
      { type: "run_created", actor: "controller", payload: { status: "created" } },
      { type: "phase_started", actor: "planner", phase, payload: {} },
      { type: "agent_started", actor: "planner", phase, payload: {} },
      {
        type: "agent_content",
        actor: "planner",
        phase,
        payload: {
          contentId: "content-1",
          kind: "assistant_message",
          chunkIndex: 0,
          chunkCount: 2,
          text: "first",
        },
      },
    ];
    const last = {
      type: "agent_content",
      actor: "planner",
      phase,
      payload: {
        contentId: "content-1",
        kind: "assistant_message",
        chunkIndex: 1,
        chunkCount: 2,
        text: "last",
      },
    };
    const write = (inputs: Record<string, unknown>[]) =>
      writeFileSync(
        path,
        inputs
          .map((input, index) =>
            JSON.stringify(record({ ...input, seq: index + 1, eventId: `${runId}:${index + 1}` })),
          )
          .join("\n") + "\n",
      );

    write([...before, last]);
    assert.equal(readTelemetry(path).length, 5);
    write([
      ...before,
      {
        ...last,
        payload: { ...last.payload, kind: "reasoning" },
      },
    ]);
    assert.throws(() => readTelemetry(path), /agent content kind changed/);
    write([
      ...before,
      {
        type: "tool_started",
        actor: "planner",
        phase,
        payload: { toolName: "read", toolCallId: "tool-1" },
      },
      {
        type: "tool_finished",
        actor: "planner",
        phase,
        payload: { toolName: "read", toolCallId: "tool-1", isError: false },
      },
      last,
    ]);
    assert.throws(() => readTelemetry(path), /interleaved with incomplete agent content/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("telemetry writer rejects content interleaving and incomplete phase closure without mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-telemetry-content-writer-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    const phase = { id: "planning:1", name: "planning" as const, attempt: 1 };
    writer.append({ type: "phase_started", actor: "planner", phase, payload: {} });
    writer.append({ type: "agent_started", actor: "planner", phase, payload: {} });
    writer.append({
      type: "agent_content",
      actor: "planner",
      phase,
      payload: {
        contentId: "content-1",
        kind: "assistant_message",
        chunkIndex: 0,
        chunkCount: 2,
        text: "first",
      },
    });
    const beforeInterleaving = readFileSync(writer.path, "utf8");
    assert.throws(
      () =>
        writer.append({
          type: "agent_content",
          actor: "planner",
          phase,
          payload: {
            contentId: "content-1",
            kind: "reasoning",
            chunkIndex: 1,
            chunkCount: 2,
            text: "last",
          },
        }),
      /agent content kind changed/,
    );
    assert.equal(readFileSync(writer.path, "utf8"), beforeInterleaving);
    assert.throws(
      () =>
        writer.append({
          type: "tool_started",
          actor: "planner",
          phase,
          payload: { toolName: "read", toolCallId: "tool-1" },
        }),
      /interleaved with incomplete agent content/,
    );
    assert.equal(readFileSync(writer.path, "utf8"), beforeInterleaving);
    writer.append({
      type: "agent_content",
      actor: "planner",
      phase,
      payload: {
        contentId: "content-1",
        kind: "assistant_message",
        chunkIndex: 1,
        chunkCount: 2,
        text: "last",
      },
    });
    writer.append({
      type: "agent_content",
      actor: "planner",
      phase,
      payload: {
        contentId: "content-2",
        kind: "assistant_message",
        chunkIndex: 0,
        chunkCount: 2,
        text: "incomplete",
      },
    });
    const beforeClosure = readFileSync(writer.path, "utf8");
    assert.throws(
      () =>
        writer.append({
          type: "phase_finished",
          actor: "planner",
          phase,
          payload: { status: "failed" },
        }),
      /interleaved with incomplete agent content/,
    );
    assert.equal(readFileSync(writer.path, "utf8"), beforeClosure);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("telemetry writer enforces content indexes and phase byte budget without mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-telemetry-content-budget-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    const phase = { id: "planning:1", name: "planning" as const, attempt: 1 };
    writer.append({ type: "phase_started", actor: "planner", phase, payload: {} });
    writer.append({ type: "agent_started", actor: "planner", phase, payload: {} });
    const beforeIndex = readFileSync(writer.path, "utf8");
    assert.throws(
      () =>
        writer.append({
          type: "agent_content",
          actor: "planner",
          phase,
          payload: {
            contentId: "bad-index",
            kind: "user_prompt",
            chunkIndex: 1,
            chunkCount: 2,
            text: "bad",
          },
        }),
      /chunk index|first chunk/,
    );
    assert.equal(readFileSync(writer.path, "utf8"), beforeIndex);

    for (const contentId of ["content-budget-1", "content-budget-2"])
      for (let chunkIndex = 0; chunkIndex < 32; chunkIndex++)
        writer.append({
          type: "agent_content",
          actor: "planner",
          phase,
          payload: {
            contentId,
            kind: "user_prompt",
            chunkIndex,
            chunkCount: 32,
            text: "x".repeat(8 * 1024),
          },
        });
    const beforeBudget = readFileSync(writer.path, "utf8");
    assert.throws(
      () =>
        writer.append({
          type: "agent_content",
          actor: "planner",
          phase,
          payload: {
            contentId: "content-budget-3",
            kind: "user_prompt",
            chunkIndex: 0,
            chunkCount: 1,
            text: "x",
          },
        }),
      /content exceeds phase limit/,
    );
    assert.equal(readFileSync(writer.path, "utf8"), beforeBudget);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("telemetry writer persists contiguous content that replay accepts", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-telemetry-content-parity-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    const phase = { id: "planning:1", name: "planning" as const, attempt: 1 };
    writer.append({ type: "phase_started", actor: "planner", phase, payload: {} });
    writer.append({ type: "agent_started", actor: "planner", phase, payload: {} });
    for (const [chunkIndex, text] of ["first", "last"].entries())
      writer.append({
        type: "agent_content",
        actor: "planner",
        phase,
        payload: {
          contentId: "content-1",
          kind: "assistant_message",
          chunkIndex,
          chunkCount: 2,
          text,
        },
      });
    writer.append({
      type: "agent_finished",
      actor: "planner",
      phase,
      payload: { status: "completed" },
    });
    writer.append({
      type: "phase_finished",
      actor: "planner",
      phase,
      payload: { status: "completed" },
    });
    assert.equal(readTelemetry(writer.path).length, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("full telemetry replay requires completed metadata for step-tagged agent phases", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-telemetry-step-"));
  try {
    const path = createTelemetryWriter(root, runId).path;
    const phase = { id: "plan:1", name: "planning", stepId: "plan", attempt: 1 };
    const inputs = [
      { type: "run_created", actor: "controller", payload: { status: "created" } },
      { type: "phase_started", actor: "planner", phase, payload: {} },
      { type: "agent_started", actor: "planner", phase, payload: {} },
      { type: "agent_finished", actor: "planner", phase, payload: { status: "completed" } },
      { type: "phase_finished", actor: "planner", phase, payload: { status: "completed" } },
    ];
    writeFileSync(
      path,
      inputs
        .map((input, index) =>
          JSON.stringify(record({ ...input, seq: index + 1, eventId: `${runId}:${index + 1}` })),
        )
        .join("\n") + "\n",
    );
    assert.throws(() => readTelemetry(path), /incomplete agent activity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("full telemetry replay binds tools to legacy and step-tagged agent lifecycles", () => {
  for (const phase of [
    { id: "planning:1", name: "planning", attempt: 1 },
    { id: "plan:1", name: "planning", stepId: "plan", attempt: 1 },
  ] as const) {
    const started = { type: "agent_started", actor: "planner", phase, payload: {} };
    const finished = {
      type: "agent_finished",
      actor: "planner",
      phase,
      payload: { status: "completed" },
    };
    const toolStarted = {
      type: "tool_started",
      actor: "planner",
      phase,
      payload: { toolName: "read", toolCallId: "tool-1" },
    };
    for (const [name, activity] of [
      ["before-start", [toolStarted]],
      ["after-finish", [started, finished, toolStarted]],
      ["finish-with-open-tool", [started, toolStarted, finished]],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), `maquila-telemetry-${name}-`));
      try {
        const path = createTelemetryWriter(root, runId).path;
        const inputs = [
          { type: "run_created", actor: "controller", payload: { status: "created" } },
          { type: "phase_started", actor: "planner", phase, payload: {} },
          ...activity,
        ];
        writeFileSync(
          path,
          inputs
            .map((input, index) =>
              JSON.stringify(
                record({ ...input, seq: index + 1, eventId: `${runId}:${index + 1}` }),
              ),
            )
            .join("\n") + "\n",
        );
        assert.throws(() => readTelemetry(path), /active agent|active tool/, `${phase.id}:${name}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("telemetry writer binds tools to active unfinished agents before usage", () => {
  const phase = { id: "plan:1", name: "planning" as const, stepId: "plan" as const, attempt: 1 };
  const append = (
    name: string,
    activity: (writer: ReturnType<typeof createTelemetryWriter>) => void,
    expected: RegExp,
  ) => {
    const root = mkdtempSync(join(tmpdir(), `maquila-telemetry-writer-${name}-`));
    try {
      const writer = createTelemetryWriter(root, runId);
      writer.append({ type: "phase_started", actor: "planner", phase, payload: {} });
      assert.throws(() => activity(writer), expected, name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const startAgent = (writer: ReturnType<typeof createTelemetryWriter>) =>
    writer.append({ type: "agent_started", actor: "planner", phase, payload: {} });
  const startTool = (writer: ReturnType<typeof createTelemetryWriter>) =>
    writer.append({
      type: "tool_started",
      actor: "planner",
      phase,
      payload: { toolName: "read", toolCallId: "tool-1" },
    });
  const finishAgent = (writer: ReturnType<typeof createTelemetryWriter>) =>
    writer.append({
      type: "agent_finished",
      actor: "planner",
      phase,
      payload: { status: "failed" },
    });

  append("before-start", startTool, /outside active agent/);
  append(
    "after-finish",
    (writer) => {
      startAgent(writer);
      finishAgent(writer);
      startTool(writer);
    },
    /outside active agent/,
  );
  append(
    "finish-with-open-tool",
    (writer) => {
      startAgent(writer);
      startTool(writer);
      finishAgent(writer);
    },
    /active tool/,
  );
});

test("agent context and usage are strict, ordered, and prompt/cost free", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-telemetry-agent-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    const phase = { id: "planning:1", name: "planning" as const, attempt: 1 };
    writer.append({ type: "phase_started", actor: "planner", phase, payload: {} });
    const context = {
      model: "provider/model",
      description: "Plans changes",
      tools: ["read"],
      thinking: "high" as const,
      access: "read-only" as const,
      systemPromptSha256: "a".repeat(64),
    };
    assert.throws(
      () =>
        writer.append({
          type: "agent_usage",
          actor: "planner",
          phase,
          payload: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        }),
      /before context/,
    );
    writer.append({ type: "agent_context", actor: "planner", phase, payload: context });
    assert.throws(
      () =>
        writer.append({
          type: "agent_usage",
          actor: "planner",
          phase,
          payload: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        }),
      /completed activity/,
    );
    writer.append({ type: "agent_started", actor: "planner", phase, payload: {} });
    assert.throws(
      () =>
        writer.append({
          type: "agent_finished",
          actor: "worker",
          phase: { ...phase, name: "implementing" },
          payload: { status: "completed" },
        }),
      /matching phase/,
    );
    assert.throws(
      () =>
        writer.append({
          type: "agent_finished",
          actor: "planner",
          phase: { ...phase, attempt: 2 },
          payload: { status: "completed" },
        }),
      /matching phase/,
    );
    writer.append({
      type: "agent_finished",
      actor: "planner",
      phase,
      payload: { status: "completed" },
    });
    writer.append({
      type: "agent_usage",
      actor: "planner",
      phase,
      payload: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        total: 2,
        contextTokens: 50_000,
        contextWindow: 200_000,
      },
    });
    assert.throws(
      () => writer.append({ type: "agent_context", actor: "planner", phase, payload: context }),
      /duplicate/,
    );
    assert.throws(
      () =>
        parseTelemetryRecord(
          record({
            type: "agent_context",
            actor: "planner",
            phase,
            payload: { ...context, prompt: "secret" },
          }),
        ),
      /invalid telemetry/,
    );
    assert.throws(
      () =>
        parseTelemetryRecord(
          record({
            type: "agent_usage",
            actor: "planner",
            phase,
            payload: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: 0 },
          }),
        ),
      /invalid telemetry/,
    );
    for (const payload of [
      { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, contextTokens: 1 },
      { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, contextWindow: 10 },
    ])
      assert.throws(
        () =>
          parseTelemetryRecord(record({ type: "agent_usage", actor: "planner", phase, payload })),
        /context usage/,
      );
    assert.throws(
      () =>
        writer.append({
          type: "tool_started",
          actor: "planner",
          phase,
          payload: { toolName: "read", toolCallId: "late" },
        }),
      /after usage/,
    );
    const usage = readTelemetry(writer.path).at(-1);
    assert.equal(usage?.type, "agent_usage");
    assert.equal(usage?.type === "agent_usage" ? usage.payload.contextTokens : undefined, 50_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("phase closure must match active actor and full phase identity", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-telemetry-phase-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    const phase = { id: "planning:1", name: "planning" as const, attempt: 1 };
    writer.append({ type: "phase_started", actor: "planner", phase, payload: {} });
    assert.throws(
      () =>
        writer.append({
          type: "phase_finished",
          actor: "worker",
          phase: { ...phase, name: "implementing" },
          payload: { status: "completed" },
        }),
      /does not match/,
    );
    assert.throws(
      () =>
        writer.append({
          type: "phase_finished",
          actor: "planner",
          phase: { ...phase, attempt: 2 },
          payload: { status: "completed" },
        }),
      /does not match/,
    );
    writer.append({
      type: "phase_finished",
      actor: "planner",
      phase,
      payload: { status: "failed" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay rejects reuse of a closed phase ID", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-telemetry-phase-reuse-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    const phase = { id: "planning:1", name: "planning" as const, attempt: 1 };
    const started = writer.append({
      type: "phase_started",
      actor: "planner",
      phase,
      payload: {},
    });
    writer.append({
      type: "phase_finished",
      actor: "planner",
      phase,
      payload: { status: "failed" },
    });
    appendFileSync(
      writer.path,
      `${JSON.stringify({ ...started, seq: 3, eventId: `${runId}:3` })}\n`,
    );
    assert.throws(() => readTelemetry(writer.path), /duplicate phase start/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writer assigns gap-free sequence across reopen and replay ignores partial tail", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-telemetry-"));
  try {
    const first = createTelemetryWriter(root, runId);
    assert.equal(
      first.append({ type: "run_created", actor: "controller", payload: { status: "created" } })
        .seq,
      1,
    );
    const second = createTelemetryWriter(root, runId);
    assert.equal(
      second.append({
        type: "failure",
        actor: "controller",
        payload: { stage: "unicode", message: "café 🚀" },
      }).seq,
      2,
    );
    appendFileSync(second.path, '{"partial":');
    assert.deepEqual(
      readTelemetry(second.path).map((event) => event.seq),
      [1, 2],
    );
    const third = createTelemetryWriter(root, runId);
    assert.equal(
      third.append({ type: "run_started", actor: "controller", payload: { status: "running" } })
        .seq,
      3,
    );
    assert.deepEqual(
      readTelemetry(third.path).map((event) => event.seq),
      [1, 2, 3],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal telemetry permits only later cleanup reconciliation", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-telemetry-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    writer.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    writer.append({
      type: "run_finished",
      actor: "controller",
      payload: { status: "failed", cleanup: "failed" },
    });
    const reopened = createTelemetryWriter(root, runId);
    reopened.append({
      type: "cleanup_updated",
      actor: "controller",
      payload: { cleanup: "complete" },
    });
    assert.throws(
      () =>
        reopened.append({
          type: "cleanup_updated",
          actor: "controller",
          payload: { cleanup: "complete" },
        }),
      /already terminal/,
    );
    assert.throws(
      () =>
        reopened.append({
          type: "failure",
          actor: "controller",
          payload: { stage: "x", message: "x" },
        }),
      /already terminal/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("decision expiry is an honest cancelled terminal", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-telemetry-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    writer.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    writer.append({
      type: "run_finished",
      actor: "controller",
      payload: { status: "cancelled", cleanup: "complete", reason: "decision_expired" },
    });
    assert.equal(readTelemetry(writer.path).at(-1)?.type, "run_finished");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay rejects a complete sequence gap", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-telemetry-"));
  const path = telemetryPath(root, runId);
  try {
    const writer = createTelemetryWriter(root, runId);
    writer.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...value, seq: 2, eventId: `${runId}:2` })}\n`);
    assert.throws(() => readTelemetry(path), /gap-free/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful telemetry requires cleanup and publication metadata is strict", () => {
  for (const status of ["ready_for_publication", "completed"]) {
    assert.throws(
      () =>
        parseTelemetryRecord(
          record({
            type: "run_finished",
            payload: { status, cleanup: "failed" },
          }),
        ),
      /requires cleanup/,
    );
  }
  assert.doesNotThrow(() =>
    parseTelemetryRecord(
      record({
        type: "publication_completed",
        payload: {
          number: 42,
          url: "https://github.com/santychuy/bookbounce/pull/42",
          branch: "maquila/riff-40-aaaaaaaaaaaa",
          commitSha: "b".repeat(40),
        },
      }),
    ),
  );
  assert.throws(
    () =>
      parseTelemetryRecord(
        record({
          type: "publication_completed",
          payload: {
            number: 42,
            url: "https://evil.example/pull/42",
            branch: "maquila/riff-40-aaaaaaaaaaaa",
            commitSha: "b".repeat(40),
          },
        }),
      ),
    /invalid telemetry/,
  );
  for (const name of [".", "..", "bad/path", "bad\\path", "bad\0name"])
    assert.throws(
      () =>
        parseTelemetryRecord(record({ type: "artifact_available", payload: { name, size: 1 } })),
      /artifact name|invalid telemetry/,
    );
});

test("telemetry ledger rejects aggregate size overflow before replay and append", () => {
  const root = mkdtempSync(join(tmpdir(), "maquila-telemetry-"));
  try {
    const writer = createTelemetryWriter(root, runId);
    writer.append({ type: "run_created", actor: "controller", payload: { status: "created" } });
    truncateSync(writer.path, MAX_TELEMETRY_FILE_BYTES);
    assert.throws(
      () => writer.append({ type: "heartbeat", actor: "controller", payload: {} }),
      /file exceeds limit/,
    );
    truncateSync(writer.path, MAX_TELEMETRY_FILE_BYTES + 1);
    assert.throws(() => readTelemetry(writer.path), /file exceeds limit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("telemetry failure text redacts longest overlapping secrets and control characters", () => {
  assert.equal(
    sanitizeTelemetryText("bad\nabcdef\u001B]8;;https://evil.example\u0007link\u0085", [
      "abc",
      "abcdef",
    ]),
    "bad [REDACTED] ]8;;https://evil.example link",
  );
});
