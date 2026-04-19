import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Card, PageHeader, StatusBadge, formatCost, formatDateTime } from "@/components/ui";
import { WorkflowForm } from "../workflow-form";
import { RunNowButton } from "./run-now-button";

type Params = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export default async function WorkflowDetailPage({ params }: Params) {
  const { id } = await params;
  const [workflow, agents] = await Promise.all([
    prisma.workflow.findUnique({
      where: { id },
      include: {
        steps: { orderBy: { order: "asc" } },
        runs: { orderBy: { startedAt: "desc" }, take: 10 },
      },
    }),
    prisma.agent.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  if (!workflow) notFound();

  return (
    <div>
      <PageHeader
        title={workflow.name}
        subtitle="Edit steps, trigger a manual run, or view history."
        action={<RunNowButton workflowId={workflow.id} />}
      />

      <div className="mb-6">
        <WorkflowForm
          agents={agents}
          initial={{
            id: workflow.id,
            name: workflow.name,
            schedule: workflow.schedule,
            enabled: workflow.enabled,
            steps: workflow.steps.map((s) => ({
              agentId: s.agentId,
              inputTemplate: s.inputTemplate,
              requiresApproval: s.requiresApproval,
            })),
          }}
        />
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-neutral-300">Recent runs</h2>
        {workflow.runs.length === 0 ? (
          <p className="text-sm text-neutral-500">No runs yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-800">
            {workflow.runs.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-2">
                <Link href={`/runs/${r.id}`} className="text-sm hover:underline">
                  {formatDateTime(r.startedAt)}
                </Link>
                <div className="flex items-center gap-3 text-xs text-neutral-500">
                  <span>{r.trigger}</span>
                  <span>{formatCost(r.totalCost)}</span>
                  <StatusBadge status={r.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
