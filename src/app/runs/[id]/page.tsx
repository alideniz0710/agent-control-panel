import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui";
import { RunView } from "./run-view";

type Params = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export default async function RunDetailPage({ params }: Params) {
  const { id } = await params;
  const run = await prisma.run.findUnique({
    where: { id },
    include: {
      workflow: true,
      tasks: {
        orderBy: { stepOrder: "asc" },
        include: {
          agent: true,
          logs: { orderBy: { at: "asc" } },
        },
      },
    },
  });
  if (!run) notFound();

  const initial = {
    id: run.id,
    status: run.status,
    workflowName: run.workflow.name,
    trigger: run.trigger,
    totalCost: run.totalCost,
    tasks: run.tasks.map((t) => ({
      id: t.id,
      stepOrder: t.stepOrder,
      status: t.status,
      input: t.input,
      output: t.output,
      tokensIn: t.tokensIn,
      tokensOut: t.tokensOut,
      cost: t.cost,
      error: t.error,
      agentName: t.agent.name,
      agentModel: t.agent.model,
      logs: t.logs.map((l) => ({ level: l.level, text: l.text, at: l.at.toISOString() })),
    })),
  };

  return (
    <div>
      <PageHeader title={run.workflow.name} subtitle={`Run started ${run.startedAt.toLocaleString()} (${run.trigger})`} />
      <RunView initial={initial} />
    </div>
  );
}
