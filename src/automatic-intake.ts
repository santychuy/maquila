import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LinearWebhookValidationError, verifyLinearWebhook } from "./linear-webhook.js";
import { listLinearAutomaticCandidates } from "./integrations/linear.js";

const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DELIVERIES = 10_000;
const MAX_HANDLED = 10_000;
const MAX_PENDING = 100;
const MAX_PAGES = 10;
const WEBHOOK_DEADLINE_MS = 4_000;

interface PendingIssue {
  issueId: string;
  queuedAt: string;
  attempts: number;
  nextAttemptAt: string;
  runId?: string;
}

interface HandledIssue {
  issueId: string;
  runId: string;
  acceptedAt: string;
  accessPublished: boolean;
}

export interface AutomaticIntakeState {
  version: 1;
  deliveries: string[];
  pending: PendingIssue[];
  handled: HandledIssue[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function errorCode(value: unknown): string | undefined {
  return record(value) && typeof value.code === "string" ? value.code : undefined;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function valid(value: unknown): value is AutomaticIntakeState {
  if (!record(value)) return false;
  if (!exact(value, ["version", "deliveries", "pending", "handled"])) return false;
  if (
    value.version !== VERSION ||
    !Array.isArray(value.deliveries) ||
    !Array.isArray(value.pending) ||
    !Array.isArray(value.handled) ||
    value.deliveries.length > MAX_DELIVERIES ||
    value.handled.length > MAX_HANDLED ||
    value.pending.length > MAX_PENDING
  )
    return false;
  if (
    !value.deliveries.every((id) => typeof id === "string" && UUID.test(id)) ||
    new Set(value.deliveries).size !== value.deliveries.length
  )
    return false;
  const pendingIds = new Set<string>();
  for (const item of value.pending) {
    if (
      !record(item) ||
      !exact(item, ["issueId", "queuedAt", "attempts", "nextAttemptAt", "runId"])
    )
      return false;
    if (
      typeof item.issueId !== "string" ||
      !UUID.test(item.issueId) ||
      pendingIds.has(item.issueId) ||
      !timestamp(item.queuedAt) ||
      !timestamp(item.nextAttemptAt) ||
      typeof item.attempts !== "number" ||
      !Number.isSafeInteger(item.attempts) ||
      item.attempts < 0 ||
      item.attempts > 1_000 ||
      (item.runId !== undefined && (typeof item.runId !== "string" || !UUID.test(item.runId)))
    )
      return false;
    pendingIds.add(item.issueId);
  }
  const handledIds = new Set<string>();
  for (const item of value.handled) {
    if (!record(item) || !exact(item, ["issueId", "runId", "acceptedAt", "accessPublished"]))
      return false;
    if (
      typeof item.issueId !== "string" ||
      !UUID.test(item.issueId) ||
      handledIds.has(item.issueId) ||
      pendingIds.has(item.issueId) ||
      typeof item.runId !== "string" ||
      !UUID.test(item.runId) ||
      !timestamp(item.acceptedAt) ||
      typeof item.accessPublished !== "boolean"
    )
      return false;
    handledIds.add(item.issueId);
  }
  return true;
}

export function readAutomaticIntakeState(path: string): AutomaticIntakeState {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!valid(value)) throw new Error("automatic intake state malformed");
    return value;
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return { version: 1, deliveries: [], pending: [], handled: [] };
    throw error;
  }
}

export function writeAutomaticIntakeState(path: string, state: AutomaticIntakeState): void {
  if (!valid(state)) throw new Error("automatic intake state malformed");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function rememberDelivery(values: string[], value: string): void {
  values.push(value);
  if (values.length > MAX_DELIVERIES) values.splice(0, values.length - MAX_DELIVERIES);
}

export function enqueueWebhookIssue(
  path: string,
  body: string | Buffer,
  headers: { signature?: string; delivery?: string; timestamp?: string; secret: string },
  now = Date.now(),
): boolean {
  const event = verifyLinearWebhook({ body, ...headers, now });
  const state = readAutomaticIntakeState(resolve(path));
  if (state.deliveries.includes(event.deliveryId)) return false;
  if (event.action === "remove") {
    rememberDelivery(state.deliveries, event.deliveryId);
    writeAutomaticIntakeState(path, state);
    return false;
  }
  if (
    state.handled.some((item) => item.issueId === event.issueId) ||
    state.pending.some((item) => item.issueId === event.issueId)
  ) {
    rememberDelivery(state.deliveries, event.deliveryId);
    writeAutomaticIntakeState(path, state);
    return false;
  }
  if (state.pending.length >= MAX_PENDING) throw new Error("automatic intake queue full");
  const queuedAt = new Date(now).toISOString();
  rememberDelivery(state.deliveries, event.deliveryId);
  state.pending.push({ issueId: event.issueId, queuedAt, attempts: 0, nextAttemptAt: queuedAt });
  writeAutomaticIntakeState(path, state);
  return true;
}

export class AutomaticLaunchUncertainError extends Error {}

export interface AutomaticDispatchResult {
  issueId: string;
  status: "accepted" | "ineligible" | "pending";
  runId?: string;
}

function defer(state: AutomaticIntakeState, item: PendingIssue, now: number): void {
  item.attempts = Math.min(1_000, item.attempts + 1);
  item.nextAttemptAt = new Date(
    now + Math.min(60_000, 1_000 * 2 ** Math.min(item.attempts, 6)),
  ).toISOString();
}

function accept(
  path: string,
  state: AutomaticIntakeState,
  item: PendingIssue,
  runId: string,
  now: number,
): AutomaticDispatchResult {
  if (state.handled.length >= MAX_HANDLED) throw new Error("automatic intake handled ledger full");
  state.pending = state.pending.filter((candidate) => candidate.issueId !== item.issueId);
  state.handled.push({
    issueId: item.issueId,
    runId,
    acceptedAt: new Date(now).toISOString(),
    accessPublished: false,
  });
  writeAutomaticIntakeState(path, state);
  return { issueId: item.issueId, status: "accepted", runId };
}

export async function dispatchAutomaticIntake(options: {
  path: string;
  now?: number;
  launch: (issueId: string, runId: string) => Promise<{ runId: string }>;
  eligible: (issueId: string) => Promise<boolean>;
  admitted: (issueId: string, runId: string) => Promise<boolean>;
  createRunId?: () => string;
}): Promise<AutomaticDispatchResult | undefined> {
  const now = options.now ?? Date.now();
  const state = readAutomaticIntakeState(options.path);
  const item = state.pending.find((candidate) => Date.parse(candidate.nextAttemptAt) <= now);
  if (!item) return undefined;
  let eligible: boolean;
  try {
    eligible = await options.eligible(item.issueId);
  } catch {
    defer(state, item, now);
    writeAutomaticIntakeState(options.path, state);
    return { issueId: item.issueId, status: "pending" };
  }
  if (!eligible) {
    state.pending = state.pending.filter((candidate) => candidate.issueId !== item.issueId);
    writeAutomaticIntakeState(options.path, state);
    return { issueId: item.issueId, status: "ineligible" };
  }
  if (!item.runId) {
    const runId = (options.createRunId ?? randomUUID)();
    if (!UUID.test(runId)) throw new Error("automatic run ID invalid");
    item.runId = runId;
    writeAutomaticIntakeState(options.path, state);
  }
  try {
    if (await options.admitted(item.issueId, item.runId))
      return accept(options.path, state, item, item.runId, now);
    const result = await options.launch(item.issueId, item.runId);
    if (result.runId !== item.runId) throw new Error("automatic run identity mismatch");
    return accept(options.path, state, item, item.runId, now);
  } catch (error) {
    if (!(error instanceof AutomaticLaunchUncertainError)) delete item.runId;
    defer(state, item, now);
    writeAutomaticIntakeState(options.path, state);
    return { issueId: item.issueId, status: "pending" };
  }
}

export interface AutomaticIntakeService {
  close(): Promise<void>;
  tick(): Promise<void>;
  port(): number;
}

function header(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function runAutomaticIntakeService(options: {
  statePath: string;
  secret: string;
  port: number;
  target: string;
  linearToken: string;
  launch: (issueId: string, runId: string) => Promise<{ runId: string }>;
  eligible: (issueId: string) => Promise<boolean>;
  admitted: (issueId: string, runId: string) => Promise<boolean>;
  pollMilliseconds?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  onAccepted?: (issueId: string, runId: string, acceptedAt: string) => Promise<void> | void;
  webhookDeadlineMilliseconds?: number;
}): Promise<AutomaticIntakeService> {
  if (
    !options.secret ||
    !options.target ||
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  )
    throw new Error("automatic intake options invalid");
  const poll = options.pollMilliseconds ?? 60_000;
  if (!Number.isInteger(poll) || poll < 1_000 || poll > 3_600_000)
    throw new Error("poll interval invalid");
  const webhookDeadline = options.webhookDeadlineMilliseconds ?? WEBHOOK_DEADLINE_MS;
  if (!Number.isInteger(webhookDeadline) || webhookDeadline < 10 || webhookDeadline > 4_000)
    throw new Error("webhook deadline invalid");

  const enqueuePage = (issueIds: string[]) => {
    const state = readAutomaticIntakeState(options.statePath);
    const now = (options.now ?? Date.now)();
    for (const issueId of issueIds) {
      if (state.pending.length >= MAX_PENDING) break;
      if (
        !state.pending.some((item) => item.issueId === issueId) &&
        !state.handled.some((item) => item.issueId === issueId)
      ) {
        const queuedAt = new Date(now).toISOString();
        state.pending.push({ issueId, queuedAt, attempts: 0, nextAttemptAt: queuedAt });
      }
    }
    writeAutomaticIntakeState(options.statePath, state);
  };
  const publishAccess = async () => {
    if (!options.onAccepted) return;
    const state = readAutomaticIntakeState(options.statePath);
    for (const item of state.handled.filter((handled) => !handled.accessPublished)) {
      try {
        await options.onAccepted(item.issueId, item.runId, item.acceptedAt);
        item.accessPublished = true;
        writeAutomaticIntakeState(options.statePath, state);
      } catch {
        return;
      }
    }
  };
  const work = async () => {
    let reconciliationError: unknown;
    try {
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const listed = await listLinearAutomaticCandidates({
          fetch: options.fetch,
          token: options.linearToken,
          ...(after ? { after } : {}),
        });
        enqueuePage(listed.candidates.map((candidate) => candidate.id));
        if (!listed.hasNextPage) break;
        if (!listed.endCursor || listed.endCursor === after)
          throw new Error("Linear candidate pagination did not advance");
        after = listed.endCursor;
        if (page === MAX_PAGES - 1) throw new Error("Linear candidate pagination limit exceeded");
      }
    } catch (error) {
      reconciliationError = error;
    }
    await dispatchAutomaticIntake({
      path: options.statePath,
      launch: options.launch,
      eligible: options.eligible,
      admitted: options.admitted,
      now: (options.now ?? Date.now)(),
    });
    await publishAccess();
    if (reconciliationError) throw reconciliationError;
  };
  let serial = Promise.resolve();
  const tick = () => {
    serial = serial.then(work, work);
    return serial;
  };
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== "/hooks/linear") {
      response.statusCode = 404;
      response.end();
      return;
    }
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      response.statusCode = 408;
      response.end();
      request.destroy();
    }, webhookDeadline);
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        if (expired) return;
        const part = Buffer.from(chunk);
        size += part.length;
        if (size > 256 * 1024) {
          response.statusCode = 413;
          response.end();
          return;
        }
        chunks.push(part);
      }
      enqueueWebhookIssue(options.statePath, Buffer.concat(chunks), {
        secret: options.secret,
        signature: header(request.headers["linear-signature"]),
        delivery: header(request.headers["linear-delivery"]),
        timestamp: header(request.headers["linear-timestamp"]),
      });
      response.statusCode = 200;
      response.end();
      queueMicrotask(() => void tick().catch(() => undefined));
    } catch (error) {
      response.statusCode = error instanceof LinearWebhookValidationError ? 400 : 500;
      response.end();
    } finally {
      clearTimeout(deadline);
    }
  };
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolveStart);
  });
  const timer = setInterval(() => void tick().catch(() => undefined), poll);
  return {
    close: async () => {
      clearInterval(timer);
      await Promise.race([
        serial.catch(() => undefined),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
      ]);
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
    tick,
    port: () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("intake address unavailable");
      return address.port;
    },
  };
}
