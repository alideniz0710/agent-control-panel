import Link from "next/link";
import { listClaudeCodeAgents } from "@/lib/claudeCodeAgents";
import { prisma } from "@/lib/prisma";
import { Card, PageHeader } from "@/components/ui";
import { ImportClient } from "./import-client";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const [agents, existing] = await Promise.all([
    listClaudeCodeAgents(),
    prisma.agent.findMany({ where: { name: { startsWith: "cc:" } }, select: { name: true } }),
  ]);
  const existingSet = new Set(existing.map((e) => e.name.replace(/^cc:/, "")));
  return (
    <div>
      <PageHeader
        title="Import from Claude Code"
        subtitle="Pull in custom agents from ~/.claude/agents/. Choose clone (one-time copy) or live reference."
      />
      {agents.length === 0 ? (
        <Card>
          <p className="text-sm text-neutral-400">
            No agents found in <code className="rounded bg-neutral-800 px-1 py-0.5 text-xs">~/.claude/agents/</code>. Create some with Claude Code first, then come back.{" "}
            <Link href="/agents" className="underline">
              Back to agents
            </Link>
          </p>
        </Card>
      ) : (
        <ImportClient
          agents={agents.map((a) => ({
            name: a.name,
            description: a.description,
            scope: a.scope,
            model: a.model,
            tools: a.tools,
            promptPreview: a.prompt.slice(0, 400),
            alreadyImported: existingSet.has(a.name),
          }))}
        />
      )}
    </div>
  );
}
