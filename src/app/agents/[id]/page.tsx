import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { BACKENDS } from "@/lib/executor";
import { AVAILABLE_MODELS } from "@/lib/pricing";
import { PageHeader } from "@/components/ui";
import { AgentForm } from "../agent-form";

type Params = { params: Promise<{ id: string }> };

export default async function EditAgentPage({ params }: Params) {
  const { id } = await params;
  const agent = await prisma.agent.findUnique({ where: { id } });
  if (!agent) notFound();
  return (
    <div>
      <PageHeader title={agent.name} subtitle="Edit this agent or delete it." />
      <AgentForm
        backends={[...BACKENDS]}
        models={AVAILABLE_MODELS}
        initial={{ id: agent.id, name: agent.name, backend: agent.backend, model: agent.model, systemPrompt: agent.systemPrompt }}
      />
    </div>
  );
}
