import { BACKENDS } from "@/lib/executor";
import { AVAILABLE_MODELS } from "@/lib/pricing";
import { PageHeader } from "@/components/ui";
import { AgentForm } from "../agent-form";

export default function NewAgentPage() {
  return (
    <div>
      <PageHeader title="New agent" subtitle="Define a reusable agent you can drop into workflows." />
      <AgentForm backends={[...BACKENDS]} models={AVAILABLE_MODELS} />
    </div>
  );
}
