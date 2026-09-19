import type { DoctorResult } from "./doctor.js";

const AGENT_SIGNALS: Array<[string, string]> = [
  ["PI_CODING_AGENT", "true"],
  ["PI_SESSION_ID", "*"],
  ["CLAUDECODE", "1"],
  ["CURSOR_TRACE_ID", "*"],
  ["GITHUB_COPILOT_TOKEN", "*"],
  ["COPILOT_AGENT_ENABLED", "1"],
  ["AIDER_MODEL", "*"],
  ["AIDER_CHAT_HISTORY_FILE", "*"],
  ["OPENCODE", "1"],
];

export function detectAgentEnvironment(env: NodeJS.ProcessEnv): string | null {
  for (const [key, want] of AGENT_SIGNALS) {
    const value = env[key];
    if (value === undefined || value === "") continue;
    if (want === "*" || value === want) return key;
  }
  return null;
}

export function isAgentMode(agent: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  return agent === true || detectAgentEnvironment(env) !== null;
}

const PENDING_VIA: Record<string, string[]> = {
  target: ["--target"],
  github: ["GITHUB_TOKEN", "GH_TOKEN"],
  linear: ["maquila setup", "LINEAR_API_TOKEN", "--linear-token-reference"],
  workspace: ["maquila setup", "LINEAR_API_TOKEN", "--linear-token-reference"],
  issue: ["--issue", "--require-label"],
  openrouter: ["maquila setup", "OPENROUTER_API_KEY", "--openrouter-token-reference"],
  credits: ["maquila setup", "OPENROUTER_API_KEY", "--openrouter-token-reference"],
  ssh: ["--identity", "MAQUILA_EXE_IDENTITY"],
  skill: ["--install-skill"],
};

export function renderAgentProgress(result: DoctorResult): string {
  const failed = result.checks.filter((item) => item.status === "fail");
  const warnings = result.checks.filter((item) => item.status === "warn");
  const resolved = result.checks.filter((item) => item.status === "pass");
  const lines = [
    `# Maquila setup: ${failed.length > 0 ? "incomplete" : "complete"}`,
    "",
    "## Resolved",
  ];
  if (resolved.length === 0) lines.push("- none");
  for (const item of resolved) lines.push(`- **${item.id}**: ${item.message}`);
  lines.push("", "## Pending");
  if (failed.length === 0) lines.push("No pending checks. Rerun setup or doctor to verify.");
  for (const item of failed) {
    lines.push(`### ${item.id} (required)`);
    lines.push(item.remediation ?? item.message);
    lines.push("", "```json");
    lines.push(
      JSON.stringify({ check: item.id, status: item.status, via: PENDING_VIA[item.id] ?? [] }),
    );
    lines.push("```", "");
  }
  if (warnings.length > 0) {
    lines.push("## Warnings");
    for (const item of warnings) {
      lines.push(`### ${item.id} (optional)`);
      lines.push(item.remediation ?? item.message);
      lines.push("", "```json");
      lines.push(
        JSON.stringify({ check: item.id, status: item.status, via: PENDING_VIA[item.id] ?? [] }),
      );
      lines.push("```", "");
    }
  }
  return `${lines.join("\n")}\n`;
}
