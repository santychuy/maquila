import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { factoryRoot } from "../runtime.js";

export const ALLOWED_AGENT_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
export type AgentToolName = (typeof ALLOWED_AGENT_TOOLS)[number];

const ALLOWED_TOOLS = new Set<string>(ALLOWED_AGENT_TOOLS);
const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);
const ALLOWED_FIELDS = new Set(["name", "description", "tools", "thinking", "access"]);
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type AgentThinking = (typeof THINKING_LEVELS)[number];

function isAgentThinking(value: string): value is AgentThinking {
  return THINKING_LEVELS.some((level) => level === value);
}

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  thinking: AgentThinking;
  access: "read-only" | "writer";
  systemPrompt: string;
  filePath: string;
}

interface AgentFrontmatter extends Record<string, unknown> {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  thinking?: unknown;
  access?: unknown;
}

export function defaultAgentsDir(): string {
  return resolve(factoryRoot(resolve(import.meta.dirname, "..")), "src", "agents");
}

function nonEmptyString(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${filePath}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseTools(value: unknown, filePath: string): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = values.map((tool) => nonEmptyString(tool, "tools entry", filePath));
  if (!tools.length) throw new Error(`${filePath}: tools must be a non-empty list`);
  if (new Set(tools).size !== tools.length)
    throw new Error(`${filePath}: tools must not contain duplicates`);
  const unknown = tools.filter((tool) => !ALLOWED_TOOLS.has(tool));
  if (unknown.length) throw new Error(`${filePath}: unsupported tools: ${unknown.join(", ")}`);
  return tools;
}

export function loadAgentFile(filePath: string): AgentDefinition {
  const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(readFileSync(filePath, "utf8"));
  const unknownFields = Object.keys(frontmatter).filter((field) => !ALLOWED_FIELDS.has(field));
  if (unknownFields.length)
    throw new Error(`${filePath}: unknown fields: ${unknownFields.join(", ")}`);

  const name = nonEmptyString(frontmatter.name, "name", filePath);
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    throw new Error(`${filePath}: name must be lowercase kebab-case`);
  if (basename(filePath, ".md") !== name)
    throw new Error(`${filePath}: filename must match agent name '${name}'`);

  const description = nonEmptyString(frontmatter.description, "description", filePath);
  const tools = parseTools(frontmatter.tools, filePath);
  const thinking =
    frontmatter.thinking === undefined
      ? "medium"
      : nonEmptyString(frontmatter.thinking, "thinking", filePath);
  if (!isAgentThinking(thinking)) {
    throw new Error(`${filePath}: unsupported thinking level '${thinking}'`);
  }
  const access = nonEmptyString(frontmatter.access, "access", filePath);
  if (access !== "read-only" && access !== "writer") {
    throw new Error(`${filePath}: access must be 'read-only' or 'writer'`);
  }
  const mutationTools = tools.filter((tool) => MUTATING_TOOLS.has(tool));
  if (access === "read-only" && mutationTools.length) {
    throw new Error(`${filePath}: read-only agent cannot use: ${mutationTools.join(", ")}`);
  }
  if (access === "writer" && !mutationTools.length) {
    throw new Error(`${filePath}: writer agent needs at least one mutation tool`);
  }
  if (!body.trim()) throw new Error(`${filePath}: system prompt body is required`);

  return {
    name,
    description,
    tools,
    thinking,
    access,
    systemPrompt: body.trim(),
    filePath,
  };
}

export function listAgents(agentsDir = defaultAgentsDir()): AgentDefinition[] {
  if (!existsSync(agentsDir)) throw new Error(`Agents directory not found: ${agentsDir}`);
  const agents = readdirSync(agentsDir)
    .filter((name) => name.endsWith(".md"))
    .toSorted()
    .map((name) => loadAgentFile(resolve(agentsDir, name)));
  const names = agents.map((agent) => agent.name);
  if (new Set(names).size !== names.length)
    throw new Error(`Duplicate agent names in ${agentsDir}`);
  return agents;
}

export function loadAgent(name: string, agentsDir = defaultAgentsDir()): AgentDefinition {
  const agents = listAgents(agentsDir);
  const agent = agents.find((candidate) => candidate.name === name);
  if (!agent)
    throw new Error(
      `Unknown agent '${name}'. Available: ${agents.map((item) => item.name).join(", ")}`,
    );
  return agent;
}
