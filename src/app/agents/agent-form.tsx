"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, Field, Input, Select, Textarea } from "@/components/ui";

type AgentFormProps = {
  backends: string[];
  models: string[];
  initial?: {
    id: string;
    name: string;
    backend: string;
    model: string;
    systemPrompt: string | null;
  };
};

export function AgentForm({ backends, models, initial }: AgentFormProps) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const [backend, setBackend] = useState(initial?.backend ?? backends[0]);
  const [model, setModel] = useState(initial?.model ?? models[0]);
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const url = initial ? `/api/agents/${initial.id}` : "/api/agents";
      const res = await fetch(url, {
        method: initial ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, backend, model, systemPrompt: systemPrompt || null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.formErrors?.[0] ?? res.statusText);
      }
      router.push("/agents");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!initial) return;
    if (!confirm("Delete this agent?")) return;
    const res = await fetch(`/api/agents/${initial.id}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error ?? "delete failed");
      return;
    }
    router.push("/agents");
    router.refresh();
  }

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Summarizer" required />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Backend" hint="claude-agent-sdk for tools/file access, anthropic-api for simple prompts, fake for dev">
            <Select value={backend} onChange={(e) => setBackend(e.target.value)}>
              {backends.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model">
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="System prompt (optional)" hint="Used as the agent's persona / instructions.">
          <Textarea
            rows={6}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="You are a careful summarizer..."
          />
        </Field>
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
    </Card>
  );
}
