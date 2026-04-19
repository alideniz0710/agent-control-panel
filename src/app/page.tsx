import { prisma } from "@/lib/prisma";
import { Card, LinkButton, PageHeader, StatusBadge, formatCost, formatDateTime } from "@/components/ui";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [activeRuns, recentRuns, agentCount, workflowCount, todayCostRow] = await Promise.all([
    prisma.run.findMany({
      where: { status: { in: ["running", "awaiting_approval", "pending"] } },
      orderBy: { startedAt: "desc" },
      include: { workflow: { select: { name: true } } },
    }),
    prisma.run.findMany({
      where: { status: { in: ["done", "failed"] } },
      orderBy: { startedAt: "desc" },
      take: 10,
      include: { workflow: { select: { name: true } } },
    }),
    prisma.agent.count(),
    prisma.workflow.count(),
    prisma.run.aggregate({
      where: { startedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      _sum: { totalCost: true },
    }),
  ]);
  const todayCost = todayCostRow._sum.totalCost ?? 0;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="A quick look at what your agents are doing."
        action={<LinkButton href="/workflows/new">New workflow</LinkButton>}
      />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Agents" value={agentCount.toString()} />
        <Stat label="Workflows" value={workflowCount.toString()} />
        <Stat label="Active runs" value={activeRuns.length.toString()} />
        <Stat label="Today's cost" value={formatCost(todayCost)} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-neutral-300">Active runs</h2>
          {activeRuns.length === 0 ? (
            <Empty text="No runs in progress." />
          ) : (
            <ul className="space-y-2">
              {activeRuns.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <Link href={`/runs/${r.id}`} className="truncate text-sm hover:underline">
                    {r.workflow.name}
                  </Link>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-neutral-500">{formatDateTime(r.startedAt)}</span>
                    <StatusBadge status={r.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold text-neutral-300">Recent runs</h2>
          {recentRuns.length === 0 ? (
            <Empty text="No runs yet. Create a workflow and hit Run now." />
          ) : (
            <ul className="space-y-2">
              {recentRuns.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <Link href={`/runs/${r.id}`} className="truncate text-sm hover:underline">
                    {r.workflow.name}
                  </Link>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-neutral-500">{formatCost(r.totalCost)}</span>
                    <StatusBadge status={r.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </Card>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded border border-dashed border-neutral-800 p-4 text-center text-sm text-neutral-500">{text}</div>;
}
