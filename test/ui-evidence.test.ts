import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerEnvelope } from "../src/envelope.js";
import {
  planRequiresUiEvidence,
  requiresUiEvidence,
  validateUiEvidenceManifest,
  validateWorkerUiEvidence,
} from "../src/ui-evidence.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=",
  "base64",
);
const alternatePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("UI evidence requirement is deterministic from approved paths", () => {
  assert.equal(requiresUiEvidence(["src/page.tsx"]), true);
  assert.equal(requiresUiEvidence(["src/controller.ts", "docs/workflows.md"]), false);
  const plan = {
    summary: "Plan",
    evidence: ["Fact"],
    changes: [{ path: "src/controller.ts", action: "modify", rationale: "Reason" }],
    verification: ["bun run test"],
    risks: [],
    decisionsNeeded: [],
    visualEvidence: { required: true, reason: "Rendered UI behavior changes" },
  };
  assert.equal(planRequiresUiEvidence(plan, ["src/controller.ts"]), true);
  assert.equal(
    planRequiresUiEvidence(
      { ...plan, visualEvidence: { required: false, reason: "No visible change" } },
      ["src/page.tsx"],
    ),
    true,
  );
});

test("UI evidence validates screenshots and detects later mutation", () => {
  const directory = mkdtempSync(join(tmpdir(), "maquila-ui-evidence-"));
  try {
    writeFileSync(join(directory, "ui-default.png"), png);
    writeFileSync(join(directory, "ui-active.png"), alternatePng);
    const envelope = {
      implemented: "Updated navigation",
      changedFiles: ["src/page.tsx"],
      validation: [],
      openRisks: [],
      visualEvidence: {
        summary: "Default and active navigation states",
        url: "http://127.0.0.1:3000",
        appStartCommand: "bun run dev --host 127.0.0.1",
        steps: ["Opened the page", "Activated navigation"],
        screenshots: [
          { file: "ui-default.png", alt: "Default navigation" },
          { file: "ui-active.png", alt: "Active navigation" },
        ],
        video: null,
        videoDurationSeconds: null,
        contactSheet: null,
        videoSkippedReason: "ffmpeg was unavailable",
      },
    } satisfies WorkerEnvelope;
    const manifest = validateWorkerUiEvidence(envelope, directory, true);
    assert.ok(manifest);
    assert.equal(manifest.screenshots.length, 2);
    assert.deepEqual(validateUiEvidenceManifest(manifest, directory), manifest);

    const mutated = Buffer.from(alternatePng);
    mutated[35] = mutated[35]! ^ 1;
    writeFileSync(join(directory, "ui-active.png"), mutated);
    assert.throws(() => validateUiEvidenceManifest(manifest, directory), /does not match files/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid optional video degrades to a screenshot-only bundle", () => {
  const directory = mkdtempSync(join(tmpdir(), "maquila-ui-video-"));
  try {
    writeFileSync(join(directory, "ui-default.png"), png);
    writeFileSync(join(directory, "ui-active.png"), alternatePng);
    writeFileSync(
      join(directory, "ui-demo.webm"),
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]),
    );
    const manifest = validateWorkerUiEvidence(
      {
        implemented: "Updated navigation",
        changedFiles: ["src/page.tsx"],
        validation: [],
        openRisks: [],
        visualEvidence: {
          summary: "Default and active navigation states",
          url: "http://127.0.0.1:3000",
          appStartCommand: "bun run dev --host 127.0.0.1",
          steps: ["Opened the page"],
          screenshots: [
            { file: "ui-default.png", alt: "Default navigation" },
            { file: "ui-active.png", alt: "Active navigation" },
          ],
          video: "ui-demo.webm",
          videoDurationSeconds: 12,
          contactSheet: null,
          videoSkippedReason: null,
        },
      },
      directory,
      true,
    );
    assert.equal(manifest?.video, null);
    assert.equal(manifest?.videoSkippedReason, "video failed deterministic validation");
    assert.equal(existsSync(join(directory, "ui-demo.webm")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("UI work fails without screenshots", () => {
  const envelope = {
    implemented: "Updated navigation",
    changedFiles: ["src/page.tsx"],
    validation: [],
    openRisks: [],
  } satisfies WorkerEnvelope;
  assert.throws(() => validateWorkerUiEvidence(envelope, "/tmp", true), /UI evidence is required/);
});
