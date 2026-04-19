import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, PageHeader, StatusBadge, formatCost, formatDateTime } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await prisma.run.findMany({
    orderBy: { startedAt: "desc" },
    take: 50,
    include: { workflow: { select: { name: true } } },
  });
  return (
    <div>
      <PageHeader title="Runs" subtitle="Last 50 runs across all workflows." />
      {runs.length === 0 ? (
        <Card>
          <p className="text-sm text-neutral-400">No runs yet.</p>
        </Card>
      ) : (
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-800 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 text-left">Workflow</th>
                <th className="px-4 py-3 text-left">Started</th>
                <th className="px-4 py-3 text-left">Trigger</th>
                <th className="px-4 py-3 text-left">Cost</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-neutral-900 last:border-0 hover:bg-neutral-900/40">
                  <td className="px-4 py-3">
                    <Link href={`/runs/${r.id}`} className="font-medium hover:underline">
                      {r.workflow.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-neutral-400">{formatDateTime(r.startedAt)}</td>
                  <td className="px-4 py-3 text-neutral-400">{r.trigger}</td>
                  <td className="px-4 py-3 text-neutral-400">{formatCost(r.totalCost)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
