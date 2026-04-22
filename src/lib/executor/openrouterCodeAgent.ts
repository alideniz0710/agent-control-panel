// OpenRouter counterpart of claudeCodeAgent.
// Reads a Claude Code agent's .md file and runs it through OpenRouter instead
// of the Anthropic SDK. Lets users with only OPENROUTER_API_KEY use their
// imported Claude Code sub-agents without changing their .env.

import { openrouterExecutor } from "./openrouter";
import { getClaudeCodeAgent, resolveModelAliasOpenRouter } from "../claudeCodeAgents";
import type { Executor, ExecutorInput } from "./types";

export const openrouterCodeAgentExecutor: Executor = async (input: ExecutorInput) => {
  const name = parseAgentName(input.tools, input.systemPrompt);
  if (!name) {
    throw new Error(
      "openrouter-code-agent backend requires the agent name in the 'tools' field (as {\"claudeCodeAgentName\":\"...\"}) or the systemPrompt",
    );
  }

  const agent = await getClaudeCodeAgent(name);
  if (!agent) throw new Error(`Claude Code agent not found: ${name}`);

  input.onLog({
    level: "info",
    text: `resolved claude-code agent "${agent.name}" from ${agent.scope}-level (routing via openrouter)`,
  });

  return openrouterExecutor({
    ...input,
    model: resolveModelAliasOpenRouter(agent.model),
    systemPrompt: agent.prompt,
  });
};

function parseAgentName(tools: unknown, systemPrompt: string | null): string | null {
  if (tools && typeof tools === "object" && !Array.isArray(tools)) {
    const obj = tools as Record<string, unknown>;
    if (typeof obj.claudeCodeAgentName === "string") return obj.claudeCodeAgentName;
  }
  if (typeof systemPrompt === "string") {
    const m = systemPrompt.match(/^@claude-code-agent:(\S+)$/);
    if (m) return m[1];
  }
  return null;
}
