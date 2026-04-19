import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, LinkButton, PageHeader, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const workflows = await prisma.workflow.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      steps: { orderBy: { order: "asc" } },
      _count: { select: { runs: true } },
    },
  });

  return (
    <div>
      <PageHeader
        title="Workflows"
        subtitle="Ordered sequences of agents. Each step's output can feed the next."
        action={<LinkButton href="/workflows/new">New workflow</LinkButton>}
      />
      {workflows.length === 0 ? (
        <Card>
          <p className="text-sm text-neutral-400">No workflows yet. Create one to start chaining agents.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {workflows.map((w) => (
            <Card key={w.id}>
              <div className="flex items-start justify-between gap-4">
                <Link href={`/workflows/${w.id}`} className="text-base font-semibold hover:underline">
                  {w.name}
                </Link>
                <StatusBadge status={w.enabled ? "running" : "pending"} />
              </div>
              <div className="mt-2 text-xs text-neutral-500">
                {w.steps.length} step{w.steps.length === 1 ? "" : "s"} · {w._count.runs} run
                {w._count.runs === 1 ? "" : "s"}
                {w.schedule ? (
                  <>
                    {" · "}
                    <span className="font-mono">{w.schedule}</span>
                  </>
                ) : (
                  " · manual only"
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
