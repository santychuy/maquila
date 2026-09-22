import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { verifyLinearWebhook } from "../src/linear-webhook.js";

const secret = "test-secret";
function event() {
  const body = JSON.stringify({ action: "update", type: "Issue", data: { id: randomUUID() } });
  const timestamp = Date.now();
  const delivery = randomUUID();
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return { body, timestamp: String(timestamp), delivery, signature, now: timestamp };
}

test("verifies Linear webhook signature and issue identity", () => {
  const input = event();
  assert.equal(verifyLinearWebhook({ ...input, secret }).deliveryId, input.delivery);
});

test("rejects tampered or stale webhook", () => {
  const input = event();
  assert.throws(() => verifyLinearWebhook({ ...input, body: `${input.body}x`, secret }));
  assert.throws(() => verifyLinearWebhook({ ...input, secret, now: input.now + 60_001 }));
});
