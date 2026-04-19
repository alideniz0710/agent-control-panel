import { NextResponse } from "next/server";
import { listClaudeCodeAgents } from "@/lib/claudeCodeAgents";

export async function GET() {
  const agents = await listClaudeCodeAgents();
  return NextResponse.json(
    agents.map((a) => ({
      name: a.name,
      description: a.description,
      model: a.model,
      tools: a.tools,
      disallowedTools: a.disallowedTools,
      scope: a.scope,
      filePath: a.filePath,
      promptPreview: a.prompt.slice(0, 400),
    })),
  );
}
