import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { BACKENDS } from "@/lib/executor";

const CreateAgentSchema = z.object({
  name: z.string().min(1).max(100),
  backend: z.enum(BACKENDS),
  model: z.string().min(1),
  systemPrompt: z.string().optional().nullable(),
  tools: z.unknown().optional(),
});

export async function GET() {
  const agents = await prisma.agent.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json(agents);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = CreateAgentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const agent = await prisma.agent.create({
    data: {
      name: parsed.data.name,
      backend: parsed.data.backend,
      model: parsed.data.model,
      systemPrompt: parsed.data.systemPrompt ?? null,
      tools: parsed.data.tools ? JSON.stringify(parsed.data.tools) : null,
    },
  });
  return NextResponse.json(agent, { status: 201 });
}
