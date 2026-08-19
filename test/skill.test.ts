import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const path = resolve(import.meta.dirname, "../../.pi/skills/software-factory/SKILL.md");

test("factory skill is valid, thin, and routes only through public commands", () => {
  const source = readFileSync(path, "utf8");
  const { frontmatter, body } = parseFrontmatter(source);
  assert.equal(frontmatter.name, "software-factory");
  assert.equal(typeof frontmatter.description, "string");
  assert.ok(String(frontmatter.description).includes("Linear issue"));
  assert.ok(body.trim().length > 0);
  assert.ok(body.split("\n").length < 500);
  assert.match(body, /observer ensure --json/);
  assert.match(body, /factory run start --issue/);
  assert.match(body, /run status --run-id/);
  assert.doesNotMatch(body, /bun run factory/);
  assert.doesNotMatch(body, /absolute target Git repository path/);
  assert.doesNotMatch(body, /ssh exe\.dev|curl .*exe\.dev|readFile|telemetryPath|destroyVm/);
  assert.match(body, /Never print environment values/);
});
