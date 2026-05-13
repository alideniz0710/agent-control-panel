// Agent memory — persistent context prepended to every task.
//
// Layout (relative to project root):
//   memory/
//     shared.md                 — all agents read
//     agents/<slug>.md          — single-agent read ("cc:software-engineer" → software-engineer.md)
//
// At task creation time we read both, concatenate them with markdown
// headers, and prepend to the task text. The agent sees a single
// well-structured prompt: "Project Context" first, then "Your task".
//
// Why filesystem instead of DB:
//   - Founder can edit via VS Code on Mac OR via git PR
//   - Survives `prisma reset` / DB wipes
//   - Diffable / reviewable via PR
//   - One source of truth (the repo, not "what does the prod DB say")
//
// Cost: every agent call now reads ~5KB more tokens. At Claude pricing
// (~$3/M input for Sonnet) this is ~$0.015 per call — negligible vs
// the value of agents not re-learning the project each time.
//
// Writing memory:
//   - Manual: edit the md files in the repo
//   - Telegram: `/memo <text>` (appends to shared.md)
//   - Telegram: `/memo <agent> <text>` (appends to agents/<agent>.md)
//   Both go through control-commands.handleMemo.

import { promises as fs } from "node:fs";
import * as path from "node:path";

const MEMORY_DIR = path.resolve(process.cwd(), "memory");

/** Convert "cc:software-engineer" → "software-engineer" (filename slug). */
export function agentSlug(agentName: string): string {
  return agentName.trim().replace(/^cc:/, "");
}

async function readIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    // Other errors (permission, etc.) — log but don't crash the agent
    console.warn(`[memory] read failed for ${filePath}:`, e);
    return "";
  }
}

/** Read the shared memory (visible to every agent). */
export async function readSharedMemory(): Promise<string> {
  return readIfExists(path.join(MEMORY_DIR, "shared.md"));
}

/** Read agent-specific memory by full agent name (e.g. "cc:software-engineer"). */
export async function readAgentMemory(agentName: string): Promise<string> {
  return readIfExists(path.join(MEMORY_DIR, "agents", `${agentSlug(agentName)}.md`));
}

/** Build the full memory-context prefix for an agent. Returns "" if
 *  no memory files exist for this agent (don't pollute prompt with
 *  empty headers). */
export async function buildMemoryContext(agentName: string): Promise<string> {
  const [shared, agent] = await Promise.all([
    readSharedMemory(),
    readAgentMemory(agentName),
  ]);
  if (!shared && !agent) return "";
  const parts: string[] = ["# Project Context"];
  if (shared) parts.push("## Shared knowledge\n\n" + shared.trim());
  if (agent) parts.push(`## Agent-specific (${agentName})\n\n${agent.trim()}`);
  parts.push("---\n\n# Your current task\n");
  return parts.join("\n\n") + "\n\n";
}

/** Append an entry to either shared.md or a specific agent's memory.
 *  Each entry gets a UTC timestamp header so context drift is
 *  diff-readable later. */
export async function appendMemoryEntry(
  entry: string,
  opts: { agentName?: string } = {},
): Promise<{ file: string; bytes: number }> {
  const target = opts.agentName
    ? path.join(MEMORY_DIR, "agents", `${agentSlug(opts.agentName)}.md`)
    : path.join(MEMORY_DIR, "shared.md");
  await fs.mkdir(path.dirname(target), { recursive: true });
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const block = `\n\n## ${ts}\n${entry.trim()}\n`;
  await fs.appendFile(target, block);
  const stat = await fs.stat(target);
  return { file: target, bytes: stat.size };
}

/** List which agents have memory files. Used in /memo command help. */
export async function listAgentMemories(): Promise<string[]> {
  try {
    const files = await fs.readdir(path.join(MEMORY_DIR, "agents"));
    return files.filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}
