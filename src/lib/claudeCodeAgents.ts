import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export type ClaudeCodeAgent = {
  name: string;
  description: string;
  tools: string[] | null;
  disallowedTools: string[] | null;
  model: string | null;
  prompt: string;
  filePath: string;
  scope: "user" | "project";
};

type Frontmatter = {
  name?: string;
  description?: string;
  tools?: string | string[];
  "disallowed-tools"?: string | string[];
  disallowedTools?: string | string[];
  model?: string;
};

function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { fm: {}, body: raw };
  const fm: Record<string, string | string[]> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^(\S+?):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      fm[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    } else {
      fm[key] = value.replace(/^['"]|['"]$/g, "");
    }
  }
  return { fm: fm as Frontmatter, body: match[2] };
}

function normalizeList(v: string | string[] | undefined): string[] | null {
  if (!v) return null;
  if (Array.isArray(v)) return v;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

async function readAgentsFromDir(dir: string, scope: "user" | "project"): Promise<ClaudeCodeAgent[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents: ClaudeCodeAgent[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    const raw = await fs.readFile(filePath, "utf8");
    const { fm, body } = parseFrontmatter(raw);
    const name = (fm.name ?? entry.name.replace(/\.md$/, "")).trim();
    agents.push({
      name,
      description: (fm.description ?? "").trim(),
      tools: normalizeList(fm.tools),
      disallowedTools: normalizeList(fm.disallowedTools ?? fm["disallowed-tools"]),
      model: fm.model ? String(fm.model).trim() : null,
      prompt: body.trim(),
      filePath,
      scope,
    });
  }
  return agents;
}

export async function listClaudeCodeAgents(projectDir?: string): Promise<ClaudeCodeAgent[]> {
  const userDir = path.join(os.homedir(), ".claude", "agents");
  const projectAgentDir = projectDir ? path.join(projectDir, ".claude", "agents") : null;

  const [userAgents, projectAgents] = await Promise.all([
    readAgentsFromDir(userDir, "user"),
    projectAgentDir ? readAgentsFromDir(projectAgentDir, "project") : Promise.resolve([]),
  ]);

  const byName = new Map<string, ClaudeCodeAgent>();
  for (const a of userAgents) byName.set(a.name, a);
  for (const a of projectAgents) byName.set(a.name, a);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getClaudeCodeAgent(name: string, projectDir?: string): Promise<ClaudeCodeAgent | null> {
  const all = await listClaudeCodeAgents(projectDir);
  return all.find((a) => a.name === name) ?? null;
}

export function resolveModelAlias(alias: string | null): string {
  if (!alias) return "claude-sonnet-4-6";
  const map: Record<string, string> = {
    opus: "claude-opus-4-7",
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5-20251001",
    inherit: "claude-sonnet-4-6",
  };
  return map[alias.toLowerCase()] ?? alias;
}

// OpenRouter uses a different naming scheme than Anthropic direct.
// Map Claude Code frontmatter aliases to OpenRouter's anthropic/* model IDs.
export function resolveModelAliasOpenRouter(alias: string | null): string {
  if (!alias) return "anthropic/claude-sonnet-4.5";
  const map: Record<string, string> = {
    opus: "anthropic/claude-opus-4.5",
    sonnet: "anthropic/claude-sonnet-4.5",
    haiku: "anthropic/claude-haiku-4.5",
    inherit: "anthropic/claude-sonnet-4.5",
    // Anthropic direct -> OpenRouter passthrough (in case user pre-resolved)
    "claude-opus-4-7": "anthropic/claude-opus-4.5",
    "claude-opus-4-5": "anthropic/claude-opus-4.5",
    "claude-sonnet-4-6": "anthropic/claude-sonnet-4.5",
    "claude-sonnet-4-5": "anthropic/claude-sonnet-4.5",
    "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4.5",
    "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
  };
  return map[alias.toLowerCase()] ?? alias;
}
