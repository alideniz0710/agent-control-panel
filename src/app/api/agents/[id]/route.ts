import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { BACKENDS } from "@/lib/executor";

const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  backend: z.enum(BACKENDS).optional(),
  model: z.string().min(1).optional(),
  systemPrompt: z.string().nullable().optional(),
  tools: z.unknown().optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(agent);
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json();
  const parsed = UpdateAgentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { tools, ...rest } = parsed.data;
  const agent = await prisma.agent.update({
    where: { id },
    data: {
      ...rest,
      ...(tools !== undefined ? { tools: tools ? JSON.stringify(tools) : null } : {}),
    },
  });
  return NextResponse.json(agent);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const inUse = await prisma.workflowStep.findFirst({ where: { agentId: id } });
  if (inUse) {
    return NextResponse.json(
      { error: "agent is used by at least one workflow step" },
      { status: 409 },
    );
  }
  await prisma.agent.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
