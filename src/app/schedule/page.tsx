import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, PageHeader, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const workflows = await prisma.workflow.findMany({
    where: { schedule: { not: null } },
    orderBy: { name: "asc" },
  });

  return (
    <div>
      <PageHeader
        title="Schedule"
        subtitle="Workflows with a cron schedule. Disabled ones won't fire automatically."
      />
      {workflows.length === 0 ? (
        <Card>
          <p className="text-sm text-neutral-400">No scheduled workflows yet.</p>
        </Card>
      ) : (
        <Card className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-800 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 text-left">Workflow</th>
                <th className="px-4 py-3 text-left">Cron</th>
                <th className="px-4 py-3 text-left">Description</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((w) => (
                <tr key={w.id} className="border-b border-neutral-900 last:border-0 hover:bg-neutral-900/40">
                  <td className="px-4 py-3">
                    <Link href={`/workflows/${w.id}`} className="font-medium hover:underline">
                      {w.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-neutral-400">{w.schedule}</td>
                  <td className="px-4 py-3 text-neutral-400">{describeCron(w.schedule!)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={w.enabled ? "running" : "pending"} />
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

function describeCron(expr: string): string {
  const trimmed = expr.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return "custom schedule";
  const [min, hr, dom, mon, dow] = parts;

  if (min === "*" && hr === "*" && dom === "*" && mon === "*" && dow === "*") return "every minute";
  if (dom === "*" && mon === "*" && dow === "*" && !hr.includes("*") && !min.includes("*")) {
    return `daily at ${hr.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  if (min.startsWith("*/")) return `every ${min.slice(2)} minute${min.slice(2) === "1" ? "" : "s"}`;
  if (hr.startsWith("*/")) return `every ${hr.slice(2)} hour${hr.slice(2) === "1" ? "" : "s"}`;
  if (dow !== "*" && dow !== "?") return `selected days at ${hr}:${min.padStart(2, "0")}`;
  return "custom schedule";
}
