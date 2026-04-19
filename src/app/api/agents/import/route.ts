import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getClaudeCodeAgent, resolveModelAlias } from "@/lib/claudeCodeAgents";

const ImportSchema = z.object({
  names: z.array(z.string().min(1)).min(1),
  mode: z.enum(["clone", "reference"]).default("clone"),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = ImportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const created: Array<{ id: string; name: string }> = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const name of parsed.data.names) {
    const cc = await getClaudeCodeAgent(name);
    if (!cc) {
      skipped.push({ name, reason: "not found" });
      continue;
    }
    const existing = await prisma.agent.findFirst({ where: { name: `cc:${name}` } });
    if (existing) {
      skipped.push({ name, reason: "already imported" });
      continue;
    }
    if (parsed.data.mode === "clone") {
      const agent = await prisma.agent.create({
        data: {
          name: `cc:${name}`,
          backend: "claude-agent-sdk",
          model: resolveModelAlias(cc.model),
          systemPrompt: cc.prompt,
          tools: cc.tools ? JSON.stringify({ allowedTools: cc.tools, disallowedTools: cc.disallowedTools }) : null,
        },
      });
      created.push({ id: agent.id, name: agent.name });
    } else {
      const agent = await prisma.agent.create({
        data: {
          name: `cc:${name}`,
          backend: "claude-code-agent",
          model: resolveModelAlias(cc.model),
          systemPrompt: null,
          tools: JSON.stringify({ claudeCodeAgentName: name }),
        },
      });
      created.push({ id: agent.id, name: agent.name });
    }
  }

  return NextResponse.json({ created, skipped }, { status: 201 });
}
