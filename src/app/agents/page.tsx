import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, LinkButton, PageHeader, formatDateTime } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const agents = await prisma.agent.findMany({ orderBy: { createdAt: "desc" } });
  return (
    <div>
      <PageHeader
        title="Agents"
        subtitle="Reusable agent definitions — pick a backend, model, and system prompt."
        action={
          <div className="flex items-center gap-2">
            <LinkButton href="/agents/import" variant="secondary">
              Import from Claude Code
            </LinkButton>
            <LinkButton href="/agents/new">New agent</LinkButton>
          </div>
        }
      />
      {agents.length === 0 ? (
        <Card>
          <p className="text-sm text-neutral-400">
            You don&apos;t have any agents yet. Create one to use in a workflow.
          </p>
        </Card>
      ) : (
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-800 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Backend</th>
                <th className="px-4 py-3 text-left">Model</th>
                <th className="px-4 py-3 text-left">Created</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} className="border-b border-neutral-900 last:border-0 hover:bg-neutral-900/40">
                  <td className="px-4 py-3">
                    <Link href={`/agents/${a.id}`} className="font-medium hover:underline">
                      {a.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-neutral-400">{a.backend}</td>
                  <td className="px-4 py-3 font-mono text-xs text-neutral-400">{a.model}</td>
                  <td className="px-4 py-3 text-neutral-500">{formatDateTime(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
