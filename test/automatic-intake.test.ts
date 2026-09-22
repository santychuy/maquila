import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AutomaticLaunchUncertainError,
  dispatchAutomaticIntake,
  enqueueWebhookIssue,
  readAutomaticIntakeState,
  runAutomaticIntakeService,
  writeAutomaticIntakeState,
} from "../src/automatic-intake.js";

function directory(): string {
  return mkdtempSync(join(tmpdir(), "maquila-intake-"));
}

function webhook(issueId = randomUUID(), action = "update") {
  const delivery = randomUUID();
  const timestamp = Date.now();
  const body = JSON.stringify({
    action,
    type: "Issue",
    data: { id: issueId },
    webhookTimestamp: timestamp,
  });
  const signature = createHmac("sha256", "secret").update(body).digest("hex");
  return { issueId, body, timestamp, delivery, signature };
}

function emptyLinearResponse(): Response {
  return new Response(
    JSON.stringify({
      data: { issues: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("durably enqueues verified delivery once and ignores removals", () => {
  const dir = directory();
  try {
    const input = webhook();
    const headers = {
      secret: "secret",
      signature: input.signature,
      delivery: input.delivery,
      timestamp: String(input.timestamp),
    };
    const path = join(dir, "automatic-intake.json");
    assert.equal(enqueueWebhookIssue(path, input.body, headers, input.timestamp), true);
    assert.equal(enqueueWebhookIssue(path, input.body, headers, input.timestamp), false);
    const removed = webhook(randomUUID(), "remove");
    assert.equal(
      enqueueWebhookIssue(
        path,
        removed.body,
        {
          secret: "secret",
          signature: removed.signature,
          delivery: removed.delivery,
          timestamp: String(removed.timestamp),
        },
        removed.timestamp,
      ),
      false,
    );
    assert.equal(readAutomaticIntakeState(path).pending.length, 1);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects malformed durable intake state", () => {
  const dir = directory();
  try {
    const path = join(dir, "state.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, deliveries: [], pending: [], handled: [], extra: true }),
    );
    assert.throws(() => readAutomaticIntakeState(path), /malformed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch persists accepted issues and backs off transient eligibility errors", async () => {
  const dir = directory();
  try {
    const path = join(dir, "state.json");
    const input = webhook();
    enqueueWebhookIssue(
      path,
      input.body,
      {
        secret: "secret",
        signature: input.signature,
        delivery: input.delivery,
        timestamp: String(input.timestamp),
      },
      input.timestamp,
    );
    const pending = await dispatchAutomaticIntake({
      path,
      now: input.timestamp,
      eligible: async () => {
        throw new Error("temporary Linear outage");
      },
      admitted: async () => false,
      launch: async () => ({ runId: randomUUID() }),
    });
    assert.equal(pending?.status, "pending");
    assert.equal(readAutomaticIntakeState(path).pending[0]?.attempts, 1);
    const runId = randomUUID();
    const accepted = await dispatchAutomaticIntake({
      path,
      now: input.timestamp + 3_000,
      eligible: async () => true,
      admitted: async () => false,
      createRunId: () => runId,
      launch: async (_issueId, claimedRunId) => ({ runId: claimedRunId }),
    });
    assert.deepEqual(accepted, { issueId: input.issueId, status: "accepted", runId });
    const state = readAutomaticIntakeState(path);
    assert.deepEqual(state.pending, []);
    assert.deepEqual(state.handled, [
      {
        issueId: input.issueId,
        runId,
        acceptedAt: new Date(input.timestamp + 3_000).toISOString(),
        accessPublished: false,
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confirmed pre-admission launch failure rotates the durable run claim", async () => {
  const dir = directory();
  try {
    const path = join(dir, "state.json");
    const input = webhook();
    enqueueWebhookIssue(
      path,
      input.body,
      {
        secret: "secret",
        signature: input.signature,
        delivery: input.delivery,
        timestamp: String(input.timestamp),
      },
      input.timestamp,
    );
    const firstRunId = randomUUID();
    await dispatchAutomaticIntake({
      path,
      now: input.timestamp,
      eligible: async () => true,
      admitted: async () => false,
      createRunId: () => firstRunId,
      launch: async () => {
        throw new Error("child rejected startup");
      },
    });
    assert.equal(readAutomaticIntakeState(path).pending[0]?.runId, undefined);
    const secondRunId = randomUUID();
    const accepted = await dispatchAutomaticIntake({
      path,
      now: input.timestamp + 3_000,
      eligible: async () => true,
      admitted: async () => false,
      createRunId: () => secondRunId,
      launch: async (_issueId, runId) => ({ runId }),
    });
    assert.equal(accepted?.runId, secondRunId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("webhook is durable before response and dispatches one accepted run", async () => {
  const dir = directory();
  const accepted: string[] = [];
  const launched: string[] = [];
  const service = await runAutomaticIntakeService({
    statePath: join(dir, "state.json"),
    secret: "secret",
    port: 0,
    target: "/tmp/repository",
    linearToken: "linear-token",
    pollMilliseconds: 60_000,
    fetch: async () => emptyLinearResponse(),
    eligible: async () => true,
    admitted: async () => false,
    launch: async (issueId, runId) => {
      launched.push(issueId);
      return { runId };
    },
    onAccepted: (issueId) => {
      accepted.push(issueId);
    },
  });
  try {
    const input = webhook();
    const response = await fetch(`http://127.0.0.1:${service.port()}/hooks/linear`, {
      method: "POST",
      body: input.body,
      headers: {
        "linear-signature": input.signature,
        "linear-delivery": input.delivery,
        "linear-timestamp": String(input.timestamp),
      },
    });
    assert.equal(response.status, 200);
    assert.equal(readAutomaticIntakeState(join(dir, "state.json")).deliveries.length, 1);
    await service.tick();
    assert.deepEqual(launched, [input.issueId]);
    assert.deepEqual(accepted, [input.issueId]);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable run claim reconciles admitted controller without relaunch", async () => {
  const dir = directory();
  try {
    const path = join(dir, "state.json");
    const input = webhook();
    const runId = randomUUID();
    enqueueWebhookIssue(
      path,
      input.body,
      {
        secret: "secret",
        signature: input.signature,
        delivery: input.delivery,
        timestamp: String(input.timestamp),
      },
      input.timestamp,
    );
    await dispatchAutomaticIntake({
      path,
      now: input.timestamp,
      eligible: async () => true,
      admitted: async () => false,
      createRunId: () => runId,
      launch: async () => {
        throw new AutomaticLaunchUncertainError("process interrupted after launch");
      },
    });
    assert.equal(readAutomaticIntakeState(path).pending[0]?.runId, runId);
    let launches = 0;
    const recovered = await dispatchAutomaticIntake({
      path,
      now: input.timestamp + 3_000,
      eligible: async () => true,
      admitted: async (_issueId, claimedRunId) => claimedRunId === runId,
      launch: async () => {
        launches += 1;
        return { runId };
      },
    });
    assert.equal(recovered?.status, "accepted");
    assert.equal(launches, 0);
    assert.equal(readAutomaticIntakeState(path).handled[0]?.runId, runId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconciliation persists each completed page before a later page fails", async () => {
  const dir = directory();
  const issueId = randomUUID();
  let calls = 0;
  const service = await runAutomaticIntakeService({
    statePath: join(dir, "state.json"),
    secret: "secret",
    port: 0,
    target: "/tmp/repository",
    linearToken: "linear-token",
    pollMilliseconds: 60_000,
    fetch: async () => {
      calls += 1;
      if (calls === 2) throw new Error("page failed");
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              edges: [
                {
                  node: {
                    id: issueId,
                    identifier: "ABC-1",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                  },
                  cursor: "cursor-1",
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    eligible: async () => true,
    admitted: async () => false,
    launch: async () => {
      throw new AutomaticLaunchUncertainError("launch still running");
    },
  });
  try {
    await assert.rejects(service.tick(), /Linear request failed/);
    assert.equal(readAutomaticIntakeState(join(dir, "state.json")).pending[0]?.issueId, issueId);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unpublished accepted access retries and slow webhook bodies time out", async () => {
  const dir = directory();
  const statePath = join(dir, "state.json");
  const issueId = randomUUID();
  const runId = randomUUID();
  writeAutomaticIntakeState(statePath, {
    version: 1,
    deliveries: [],
    pending: [],
    handled: [
      {
        issueId,
        runId,
        acceptedAt: new Date().toISOString(),
        accessPublished: false,
      },
    ],
  });
  let attempts = 0;
  const service = await runAutomaticIntakeService({
    statePath,
    secret: "secret",
    port: 0,
    target: "/tmp/repository",
    linearToken: "linear-token",
    pollMilliseconds: 60_000,
    webhookDeadlineMilliseconds: 25,
    fetch: async () => emptyLinearResponse(),
    eligible: async () => true,
    admitted: async () => false,
    launch: async (_issueId, claimedRunId) => ({ runId: claimedRunId }),
    onAccepted: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("comment unavailable");
    },
  });
  try {
    await service.tick();
    assert.equal(readAutomaticIntakeState(statePath).handled[0]?.accessPublished, false);
    await service.tick();
    assert.equal(readAutomaticIntakeState(statePath).handled[0]?.accessPublished, true);
    const status = await new Promise<number>((resolveStatus, reject) => {
      const request = httpRequest(
        `http://127.0.0.1:${service.port()}/hooks/linear`,
        { method: "POST" },
        (response) => resolveStatus(response.statusCode ?? 0),
      );
      request.once("error", reject);
      request.write("{");
    });
    assert.equal(status, 408);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
