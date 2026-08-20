import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAUDE_SONNET_4_6_REFERENCE,
  estimateReferenceNanoUsd,
  modelReference,
} from "../src/model-reference.js";

const estimate = (input: number, output: number, cacheRead: number, cacheWrite: number) =>
  estimateReferenceNanoUsd(
    { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
    CLAUDE_SONNET_4_6_REFERENCE,
  );

test("pinned models.dev reference is explicit and deterministic", () => {
  assert.deepEqual(modelReference("exe/claude-sonnet-4-6"), CLAUDE_SONNET_4_6_REFERENCE);
  assert.equal(modelReference("anthropic/claude-sonnet-4-6"), undefined);
  assert.equal(
    CLAUDE_SONNET_4_6_REFERENCE.source.commit,
    "eeffdfc0157a27e3abf6fdb75e52f91db3c8d29f",
  );
  assert.equal(
    CLAUDE_SONNET_4_6_REFERENCE.source.sha256,
    "99ed5bcf8c9c67ef14e70a38a6f98fdc56dc0b8f3409148a8ba3d70f71c31a28",
  );
});

test("reference estimates use exact checked nano-USD arithmetic", () => {
  assert.equal(estimate(0, 0, 0, 0), 0);
  assert.equal(estimate(2, 3, 4, 5), 70_950);
  assert.equal(estimate(1, 1, 0, 0), 18_000);
  assert.equal(estimate(3, 2, 0, 0), 39_000);
  assert.equal(estimate(0, 0, 1, 1), 4_050);
  assert.equal(
    estimateReferenceNanoUsd(
      { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
      CLAUDE_SONNET_4_6_REFERENCE,
    ),
    undefined,
  );
  assert.equal(
    estimateReferenceNanoUsd(
      { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, total: -1 },
      CLAUDE_SONNET_4_6_REFERENCE,
    ),
    undefined,
  );
  assert.equal(
    estimateReferenceNanoUsd(
      {
        input: Number.MAX_SAFE_INTEGER,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: Number.MAX_SAFE_INTEGER,
      },
      CLAUDE_SONNET_4_6_REFERENCE,
    ),
    undefined,
  );
  assert.equal(
    estimateReferenceNanoUsd(
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      {
        pricing: {
          mode: "tiered",
          currency: "USD",
          nanoUsdPerToken: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
        },
      },
    ),
    undefined,
  );
  assert.equal(
    estimateReferenceNanoUsd(
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      {
        pricing: {
          mode: "flat",
          currency: "USD",
          nanoUsdPerToken: Object.assign(
            { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
            { audio: 1 },
          ),
        },
      },
    ),
    undefined,
  );
});
