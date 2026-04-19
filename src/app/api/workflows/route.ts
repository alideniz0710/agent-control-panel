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

const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(100),
  schedule: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
  steps: z.array(StepSchema).min(1),
});

export async function GET() {
  const workflows = await prisma.workflow.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      steps: { orderBy: { order: "asc" }, include: { agent: true } },
      _count: { select: { runs: true } },
    },
  });
  return NextResponse.json(workflows);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = CreateWorkflowSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { schedule, steps, ...rest } = parsed.data;
  if (schedule && !cron.validate(schedule)) {
    return NextResponse.json({ error: "invalid cron expression" }, { status: 400 });
  }
  const workflow = await prisma.workflow.create({
    data: {
      ...rest,
      schedule: schedule ?? null,
      steps: {
        create: steps.map((s, i) => ({ ...s, order: i })),
      },
    },
    include: { steps: true },
  });
  void reloadSchedules();
  return NextResponse.json(workflow, { status: 201 });
}
