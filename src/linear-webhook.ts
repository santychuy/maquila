import { createHmac, timingSafeEqual } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(["create", "update", "remove"]);
const MAX_BODY = 256 * 1024;

export class LinearWebhookValidationError extends Error {}

function invalid(message: string): never {
  throw new LinearWebhookValidationError(message);
}

export interface LinearWebhookEvent {
  deliveryId: string;
  issueId: string;
  action: string;
  type: string;
  timestamp: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function verifyLinearWebhook(options: {
  body: string | Buffer;
  signature?: string;
  delivery?: string;
  timestamp?: string;
  secret: string;
  now?: number;
  maxAgeMs?: number;
}): LinearWebhookEvent {
  const body = typeof options.body === "string" ? Buffer.from(options.body) : options.body;
  if (body.length > MAX_BODY) invalid("Linear webhook body too large");
  if (!options.secret) invalid("Linear webhook secret missing");
  if (!options.signature || !/^[0-9a-f]{64}$/i.test(options.signature))
    invalid("Linear webhook signature missing");
  const expected = createHmac("sha256", options.secret).update(body).digest();
  const supplied = Buffer.from(options.signature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied))
    invalid("Linear webhook signature invalid");
  if (!options.delivery || !UUID.test(options.delivery)) invalid("Linear webhook delivery invalid");
  const timestamp = Number(options.timestamp);
  if (!Number.isSafeInteger(timestamp)) invalid("Linear webhook timestamp invalid");
  const maxAgeMs = options.maxAgeMs ?? 60_000;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 5 * 60_000)
    invalid("Linear webhook maximum age invalid");
  if (Math.abs((options.now ?? Date.now()) - timestamp) > maxAgeMs)
    invalid("Linear webhook timestamp expired");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    invalid("Linear webhook payload malformed");
  }
  if (!record(parsed)) invalid("Linear webhook payload malformed");
  const root = parsed;
  const data = root.data;
  if (!record(data)) invalid("Linear webhook issue missing");
  const issue = data;
  if (typeof issue.id !== "string" || !UUID.test(issue.id)) invalid("Linear webhook issue missing");
  if (root.type !== "Issue" || typeof root.action !== "string" || !ACTIONS.has(root.action))
    invalid("Linear webhook event invalid");
  if (
    root.webhookTimestamp !== undefined &&
    (typeof root.webhookTimestamp !== "number" ||
      !Number.isSafeInteger(root.webhookTimestamp) ||
      root.webhookTimestamp !== timestamp)
  )
    invalid("Linear webhook timestamp mismatch");
  return {
    deliveryId: options.delivery,
    issueId: issue.id,
    action: root.action,
    type: "Issue",
    timestamp,
  };
}

export const LINEAR_WEBHOOK_MAX_BODY = MAX_BODY;
