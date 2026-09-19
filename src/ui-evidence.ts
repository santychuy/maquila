import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseEnvelope, type PlannerEnvelope, type WorkerEnvelope } from "./envelope.js";

const UI_PATH = /\.(?:astro|css|html|jpe?g|jsx|less|mdx|png|sass|scss|svg|svelte|tsx|vue|webp)$/i;
const SCREENSHOT = /^ui-[a-z0-9][a-z0-9-]{0,80}\.png$/;
const CONTACT_SHEET = /^ui-[a-z0-9][a-z0-9-]{0,80}\.contact-sheet\.png$/;
const VIDEO = /^ui-[a-z0-9][a-z0-9-]{0,80}\.(?:mp4|webm)$/;
const MAX_SCREENSHOTS = 10;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;

export interface UiEvidenceFile {
  name: string;
  size: number;
  sha256: string;
}

export interface UiEvidenceScreenshot extends UiEvidenceFile {
  alt: string;
}

export interface UiEvidenceManifest {
  version: 1;
  summary: string;
  url: string;
  appStartCommand: string;
  steps: string[];
  screenshots: UiEvidenceScreenshot[];
  video: UiEvidenceFile | null;
  videoDurationSeconds: number | null;
  contactSheet: UiEvidenceFile | null;
  videoSkippedReason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-blank`);
  return value.trim();
}

function singleLine(value: unknown, label: string, maximum: number): string {
  const result = nonBlank(value, label);
  if (result.length > maximum || /[\r\n\0]/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function altText(value: unknown): string {
  const result = singleLine(value, "UI evidence alt text", 125);
  if (result.includes("#")) throw new Error("UI evidence alt text is invalid");
  return result;
}

function validPng(bytes: Buffer): boolean {
  return (
    bytes.length >= 45 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    bytes.subarray(12, 16).toString("ascii") === "IHDR" &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0 &&
    bytes
      .subarray(-12)
      .equals(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]))
  );
}

function file(path: string, name: unknown, pattern: RegExp, maximum: number): UiEvidenceFile {
  const safe = nonBlank(name, "UI evidence file");
  if (safe !== basename(safe) || !pattern.test(safe)) throw new Error("invalid UI evidence file");
  const target = resolve(path, safe);
  if (!existsSync(target)) throw new Error("UI evidence file is missing");
  const metadata = statSync(target);
  if (!metadata.isFile() || metadata.size < 8 || metadata.size > maximum)
    throw new Error("invalid UI evidence file size");
  const bytes = readFileSync(target);
  if (pattern !== VIDEO && !validPng(bytes)) throw new Error("invalid UI evidence PNG");
  if (pattern === VIDEO) {
    const webm = bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    const mp4 = bytes.subarray(4, 8).toString("ascii") === "ftyp";
    if (!webm && !mp4) throw new Error("invalid UI evidence video");
  }
  return {
    name: safe,
    size: metadata.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function loopbackUrl(value: unknown): string {
  const raw = nonBlank(value, "UI evidence URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("UI evidence URL is invalid");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname))
    throw new Error("UI evidence URL must use loopback HTTP");
  return url.href;
}

export function requiresUiEvidence(paths: readonly string[]): boolean {
  return paths.some((path) => UI_PATH.test(path));
}

export function planRequiresUiEvidence(plan: PlannerEnvelope, paths: readonly string[]): boolean {
  return plan.visualEvidence?.required === true || requiresUiEvidence(paths);
}

export function validateWorkerUiEvidence(
  envelope: WorkerEnvelope,
  runDirectory: string,
  required: boolean,
  probeVideo = false,
): UiEvidenceManifest | undefined {
  const value = envelope.visualEvidence;
  if (!value) {
    if (required) throw new Error("UI evidence is required");
    return undefined;
  }
  if (value.screenshots.length < 2 || value.screenshots.length > MAX_SCREENSHOTS)
    throw new Error("UI evidence requires 2-10 screenshots");
  if (value.steps.length < 1 || value.steps.length > 20)
    throw new Error("UI evidence requires 1-20 interaction steps");
  const screenshots = value.screenshots.map((item) => ({
    ...file(runDirectory, item.file, SCREENSHOT, MAX_SCREENSHOT_BYTES),
    alt: altText(item.alt),
  }));
  if (
    new Set(screenshots.map((item) => item.name)).size !== screenshots.length ||
    new Set(screenshots.map((item) => item.sha256)).size !== screenshots.length
  )
    throw new Error("UI evidence screenshots must be distinct");
  let video: UiEvidenceFile | null = null;
  let videoDurationSeconds: number | null = null;
  let contactSheet: UiEvidenceFile | null = null;
  let videoSkippedReason = value.videoSkippedReason
    ? singleLine(value.videoSkippedReason, "video skipped reason", 500)
    : null;
  if (value.video) {
    try {
      video = file(runDirectory, value.video, VIDEO, MAX_VIDEO_BYTES);
      const claimedDuration = value.videoDurationSeconds;
      if (
        typeof claimedDuration !== "number" ||
        !Number.isFinite(claimedDuration) ||
        claimedDuration < 10 ||
        claimedDuration > 30
      )
        throw new Error("UI evidence video must be 10-30 seconds");
      videoDurationSeconds = claimedDuration;
      if (probeVideo) {
        const measured = Number(
          execFileSync(
            "ffprobe",
            [
              "-v",
              "error",
              "-show_entries",
              "format=duration",
              "-of",
              "default=noprint_wrappers=1:nokey=1",
              resolve(runDirectory, video.name),
            ],
            { encoding: "utf8", timeout: 30_000 },
          ).trim(),
        );
        if (!Number.isFinite(measured) || measured < 10 || measured > 30)
          throw new Error("UI evidence video must be 10-30 seconds");
        videoDurationSeconds = measured;
      }
      contactSheet = value.contactSheet
        ? file(runDirectory, value.contactSheet, CONTACT_SHEET, MAX_SCREENSHOT_BYTES)
        : null;
      if (!contactSheet || videoSkippedReason)
        throw new Error("captured UI video requires a contact sheet and no skip reason");
    } catch {
      for (const name of [value.video, value.contactSheet])
        if (
          typeof name === "string" &&
          name === basename(name) &&
          (VIDEO.test(name) || CONTACT_SHEET.test(name))
        )
          rmSync(resolve(runDirectory, name), { force: true });
      video = null;
      videoDurationSeconds = null;
      contactSheet = null;
      videoSkippedReason = "video failed deterministic validation";
    }
  } else {
    if (value.videoDurationSeconds !== null || value.contactSheet || !videoSkippedReason)
      throw new Error("missing UI video requires a skip reason and no contact sheet");
  }
  const total = [...screenshots, ...(video ? [video] : []), ...(contactSheet ? [contactSheet] : [])]
    .map((item) => item.size)
    .reduce((sum, size) => sum + size, 0);
  if (total > MAX_TOTAL_BYTES) throw new Error("UI evidence exceeds total size limit");
  return {
    version: 1,
    summary: singleLine(value.summary, "UI evidence summary", 500),
    url: loopbackUrl(value.url),
    appStartCommand: singleLine(value.appStartCommand, "UI evidence app command", 1_000),
    steps: value.steps.map((step) => singleLine(step, "UI evidence step", 500)),
    screenshots,
    video,
    videoDurationSeconds,
    contactSheet,
    videoSkippedReason,
  };
}

export function validateUiEvidenceManifest(
  value: unknown,
  runDirectory: string,
): UiEvidenceManifest {
  if (!isRecord(value)) throw new Error("invalid UI evidence manifest");
  const record = value;
  if (record.version !== 1 || !Array.isArray(record.screenshots) || !Array.isArray(record.steps))
    throw new Error("invalid UI evidence manifest");
  const envelope = {
    implemented: "validated UI evidence",
    changedFiles: [],
    validation: [],
    openRisks: [],
    visualEvidence: {
      summary: record.summary,
      url: record.url,
      appStartCommand: record.appStartCommand,
      steps: record.steps,
      screenshots: record.screenshots.map((item) => {
        if (!isRecord(item)) throw new Error("invalid UI evidence screenshot");
        return { file: item.name, alt: item.alt };
      }),
      video: isRecord(record.video) ? record.video.name : null,
      videoDurationSeconds: record.videoDurationSeconds,
      contactSheet: isRecord(record.contactSheet) ? record.contactSheet.name : null,
      videoSkippedReason: record.videoSkippedReason,
    },
  };
  const worker = parseEnvelope("worker", envelope);
  if (!worker.ok || !("implemented" in worker.envelope))
    throw new Error("invalid UI evidence manifest");
  const parsed = validateWorkerUiEvidence(worker.envelope, runDirectory, true);
  if (!parsed || JSON.stringify(parsed) !== JSON.stringify(value))
    throw new Error("UI evidence manifest does not match files");
  return parsed;
}
