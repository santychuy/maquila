import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRemoteProtocolWriter,
  RemoteProtocolParser,
  type RemoteEvent,
} from "../src/remote-protocol.js";

const event: RemoteEvent = {
  type: "phase_started",
  actor: "planner",
  phase: "planning",
  stepId: "plan",
  sourceAt: new Date(0).toISOString(),
};

test("remote protocol parses arbitrary chunks and typed terminal result", () => {
  let output = "";
  const writer = createRemoteProtocolWriter((line) => (output += line));
  writer.event(event);
  writer.result({
    status: "completed",
    runDir: "/home/exedev/factory/.factory/runs/11111111-1111-1111-1111-111111111111",
  });
  const events: RemoteEvent[] = [];
  const parser = new RemoteProtocolParser((value) => events.push(value));
  for (let index = 0; index < output.length; index += 3)
    parser.push(output.slice(index, index + 3));
  assert.deepEqual(events, [event]);
  assert.equal(parser.finish().status, "completed");
});

test("remote protocol carries only fixed phase failure codes", () => {
  let output = "";
  const writer = createRemoteProtocolWriter((line) => (output += line));
  writer.result({
    status: "failed",
    runDir: "/tmp/run",
    failure: { phase: "planning", code: "model_request_failed" },
  });
  const parser = new RemoteProtocolParser(() => {});
  parser.push(output);
  assert.deepEqual(parser.finish().failure, {
    phase: "planning",
    code: "model_request_failed",
  });
  assert.throws(
    () =>
      new RemoteProtocolParser(() => {}).push(
        `${JSON.stringify({
          protocol: 2,
          kind: "result",
          remoteSeq: 1,
          status: "failed",
          runDir: "/tmp/run",
          failure: { phase: "planning", code: "model_request_failed", detail: "raw" },
        })}\n`,
      ),
    /invalid remote protocol frame/,
  );
});

test("remote protocol rejects v1 and mismatched workflow step identity", () => {
  for (const frame of [
    { protocol: 1, kind: "event", remoteSeq: 1, event },
    {
      protocol: 2,
      kind: "event",
      remoteSeq: 1,
      event: { ...event, stepId: "implement" },
    },
  ])
    assert.throws(
      () => new RemoteProtocolParser(() => {}).push(`${JSON.stringify(frame)}\n`),
      /invalid remote protocol (?:frame|step identity)/,
    );
});

test("remote protocol preserves Unicode across every raw byte split", () => {
  let output = "";
  const writer = createRemoteProtocolWriter((line) => (output += line));
  const unicode: RemoteEvent = {
    type: "tool_started",
    actor: "planner",
    phase: "planning",
    stepId: "plan",
    toolName: "read",
    toolCallId: "工具-🚀",
    sourceAt: new Date(0).toISOString(),
  };
  writer.event(unicode);
  writer.result({ status: "completed", runDir: "/tmp/run" });
  const bytes = Buffer.from(output);
  for (let split = 1; split < bytes.length; split += 1) {
    const events: RemoteEvent[] = [];
    const parser = new RemoteProtocolParser((value) => events.push(value));
    parser.push(bytes.subarray(0, split));
    parser.push(bytes.subarray(split));
    assert.deepEqual(events, [unicode]);
    assert.equal(parser.finish().status, "completed");
  }
});

test("remote protocol fails closed on malformed, out-of-order, and missing terminal frames", () => {
  assert.throws(
    () => new RemoteProtocolParser(() => {}).push('{"protocol":2,"kind":"event"}\n'),
    /invalid remote protocol frame/,
  );
  assert.throws(
    () =>
      new RemoteProtocolParser(() => {}).push(
        `${JSON.stringify({ protocol: 2, kind: "event", remoteSeq: 2, event })}\n`,
      ),
    /gap-free/,
  );
  assert.throws(() => new RemoteProtocolParser(() => {}).finish(), /terminal result missing/);
  assert.throws(
    () =>
      new RemoteProtocolParser(() => {}).push(
        `${JSON.stringify({
          protocol: 2,
          kind: "event",
          remoteSeq: 1,
          event: {
            type: "tool_started",
            actor: "planner",
            phase: "planning",
            stepId: "plan",
            toolName: "/tmp/secret-content",
            toolCallId: "secret-content",
            sourceAt: new Date().toISOString(),
          },
        })}\n`,
      ),
    /invalid remote protocol frame/,
  );
});

test("remote protocol accepts strict reported token totals and optional reported cost", () => {
  const usage = {
    type: "agent_usage",
    actor: "planner",
    phase: "planning",
    stepId: "plan",
    tokens: { input: 2, output: 3, cacheRead: 4, cacheWrite: 1, total: 10 },
    sourceAt: new Date(0).toISOString(),
  } as const;
  let output = "";
  const writer = createRemoteProtocolWriter((line) => (output += line));
  writer.event({ ...usage, reportedCostNanoUsd: 123 });
  writer.result({ status: "completed", runDir: "/tmp/run" });
  const seen: RemoteEvent[] = [];
  const parser = new RemoteProtocolParser((value) => seen.push(value));
  parser.push(output);
  assert.deepEqual(seen, [{ ...usage, reportedCostNanoUsd: 123 }]);
  assert.equal(parser.finish().status, "completed");
  for (const tokens of [
    { ...usage.tokens, total: 9 },
    { ...usage.tokens, input: -1 },
    { ...usage.tokens, output: 1.5 },
    { ...usage.tokens, input: Number.MAX_SAFE_INTEGER + 1 },
    { ...usage.tokens, cost: 0 },
    { ...usage.tokens, referenceEstimateNanoUsd: 1 },
  ]) {
    const frame = JSON.stringify({
      protocol: 2,
      kind: "event",
      remoteSeq: 1,
      event: { ...usage, tokens },
    });
    assert.throws(
      () => new RemoteProtocolParser(() => {}).push(frame + "\n"),
      /invalid remote protocol/,
    );
  }
  for (const reportedCostNanoUsd of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () =>
        new RemoteProtocolParser(() => {}).push(
          JSON.stringify({
            protocol: 2,
            kind: "event",
            remoteSeq: 1,
            event: { ...usage, reportedCostNanoUsd },
          }) + "\n",
        ),
      /invalid remote protocol/,
    );
});

test("remote protocol bounds aggregate frames and bytes", () => {
  const frame = `${JSON.stringify({ protocol: 2, kind: "event", remoteSeq: 1, event })}\n`;
  assert.throws(
    () => new RemoteProtocolParser(() => {}, { maxFrames: 0, maxBytes: 1024 }).push(frame),
    /frame count exceeds limit/,
  );
  assert.throws(
    () => new RemoteProtocolParser(() => {}, { maxFrames: 2, maxBytes: 1 }).push(frame),
    /stream exceeds limit/,
  );
});

test("remote protocol rejects data after terminal result", () => {
  let output = "";
  const writer = createRemoteProtocolWriter((line) => (output += line));
  writer.result({ status: "failed", runDir: "/tmp/run" });
  const parser = new RemoteProtocolParser(() => {});
  parser.push(output);
  assert.throws(() => parser.push("\n"), /after terminal/);
});
