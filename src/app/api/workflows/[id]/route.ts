import { NextRequest, NextResponse } from "next/server";
import cron from "node-cron";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { reloadSchedules } from "@/lib/scheduler";

const StepSchema = z.object({
  agentId: z.string().min(1),
  inputTemplate: z.string().default(""),
  requiresApproval: z.boolean().default(false),
});

const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  schedule: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  steps: z.array(StepSchema).min(1).optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const workflow = await prisma.workflow.findUnique({
    where: { id },
    include: {
      steps: { orderBy: { order: "asc" }, include: { agent: true } },
      runs: { orderBy: { startedAt: "desc" }, take: 20 },
    },
  });
  if (!workflow) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(workflow);
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json();
  const parsed = UpdateWorkflowSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { steps, schedule, ...rest } = parsed.data;
  if (schedule && !cron.validate(schedule)) {
    return NextResponse.json({ error: "invalid cron expression" }, { status: 400 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.workflow.update({
      where: { id },
      data: {
        ...rest,
        ...(schedule !== undefined ? { schedule } : {}),
      },
    });
    if (steps) {
      await tx.workflowStep.deleteMany({ where: { workflowId: id } });
      await tx.workflowStep.createMany({
        data: steps.map((s, i) => ({ ...s, order: i, workflowId: id })),
      });
    }
  });

  const workflow = await prisma.workflow.findUnique({
    where: { id },
    include: { steps: { orderBy: { order: "asc" }, include: { agent: true } } },
  });
  void reloadSchedules();
  return NextResponse.json(workflow);
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  await prisma.workflow.delete({ where: { id } });
  void reloadSchedules();
  return NextResponse.json({ ok: true });
}
