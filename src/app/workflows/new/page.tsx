import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, PageHeader } from "@/components/ui";
import { WorkflowForm } from "../workflow-form";

export default async function NewWorkflowPage() {
  const agents = await prisma.agent.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });

  if (agents.length === 0) {
    return (
      <div>
        <PageHeader title="New workflow" />
        <Card>
          <p className="text-sm text-neutral-400">
            You need at least one agent before creating a workflow.{" "}
            <Link href="/agents/new" className="underline">
              Create one
            </Link>
            .
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="New workflow" subtitle="Add steps that your agents will run in order." />
      <WorkflowForm agents={agents} />
    </div>
  );
}
