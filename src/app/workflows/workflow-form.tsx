"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, Field, Input, Select } from "@/components/ui";

type Agent = { id: string; name: string };
type Step = {
  agentId: string;
  inputTemplate: string;
  requiresApproval: boolean;
};

export type WorkflowFormInitial = {
  id: string;
  name: string;
  schedule: string | null;
  enabled: boolean;
  steps: Step[];
};

export function WorkflowForm({ agents, initial }: { agents: Agent[]; initial?: WorkflowFormInitial }) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const [schedule, setSchedule] = useState(initial?.schedule ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [steps, setSteps] = useState<Step[]>(
    initial?.steps ?? [{ agentId: agents[0]?.id ?? "", inputTemplate: "", requiresApproval: false }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateStep(idx: number, patch: Partial<Step>) {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }
  function addStep() {
    setSteps((prev) => [
      ...prev,
      { agentId: agents[0]?.id ?? "", inputTemplate: "{{previousOutput}}", requiresApproval: false },
    ]);
  }
  function removeStep(idx: number) {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
  }
  function moveStep(idx: number, dir: -1 | 1) {
    setSteps((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (agents.length === 0) throw new Error("You need at least one agent first.");
      if (steps.length === 0) throw new Error("Add at least one step.");
      const url = initial ? `/api/workflows/${initial.id}` : "/api/workflows";
      const res = await fetch(url, {
        method: initial ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          schedule: schedule || null,
          enabled,
          steps,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.formErrors?.[0] ?? err.error ?? res.statusText);
      }
      const body = await res.json();
      router.push(`/workflows/${initial?.id ?? body.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!initial) return;
    if (!confirm("Delete this workflow and all its runs?")) return;
    const res = await fetch(`/api/workflows/${initial.id}`, { method: "DELETE" });
    if (!res.ok) {
      alert("delete failed");
      return;
    }
    router.push("/workflows");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Card>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Daily digest" />
          </Field>
          <Field label="Schedule (cron)" hint={'Leave blank for manual-only. Example: "0 9 * * 1-5" = weekdays 9 AM.'}>
            <Input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 9 * * *" />
          </Field>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm text-neutral-300">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled (scheduled runs fire when on)
        </label>
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-300">Steps</h2>
          <Button type="button" variant="secondary" onClick={addStep}>
            Add step
          </Button>
        </div>
        {steps.length === 0 && <p className="text-sm text-neutral-500">No steps yet.</p>}
        <div className="flex flex-col gap-3">
          {steps.map((s, idx) => (
            <div key={idx} className="rounded border border-neutral-800 bg-neutral-950/40 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-semibold text-neutral-400">Step {idx + 1}</div>
                <div className="flex items-center gap-1">
                  <Button type="button" variant="secondary" onClick={() => moveStep(idx, -1)} disabled={idx === 0}>
                    ↑
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => moveStep(idx, 1)}
                    disabled={idx === steps.length - 1}
                  >
                    ↓
                  </Button>
                  <Button type="button" variant="danger" onClick={() => removeStep(idx)} disabled={steps.length <= 1}>
                    Remove
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="Agent">
                  <Select value={s.agentId} onChange={(e) => updateStep(idx, { agentId: e.target.value })}>
                    {agents.length === 0 && <option value="">— no agents —</option>}
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Requires approval?">
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={s.requiresApproval}
                      onChange={(e) => updateStep(idx, { requiresApproval: e.target.checked })}
                    />
                    Pause before this step until approved
                  </label>
                </Field>
              </div>
              <Field
                label={idx === 0 ? "Input" : "Input template"}
                hint={idx === 0 ? "Sent as-is when the run starts." : "Use {{previousOutput}} to reference the previous step."}
              >
                <textarea
                  rows={3}
                  value={s.inputTemplate}
                  onChange={(e) => updateStep(idx, { inputTemplate: e.target.value })}
                  placeholder={idx === 0 ? "Write a one-paragraph summary of..." : "Summarize this: {{previousOutput}}"}
                  className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
                />
              </Field>
            </div>
          ))}
        </div>
      </Card>

      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving..." : initial ? "Save" : "Create"}
        </Button>
        {initial && (
          <Button type="button" variant="danger" onClick={onDelete} disabled={busy}>
            Delete
          </Button>
        )}
      </div>
    </form>
  );
}
