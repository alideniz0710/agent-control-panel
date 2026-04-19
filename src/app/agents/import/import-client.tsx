"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, Select } from "@/components/ui";

type Item = {
  name: string;
  description: string;
  scope: "user" | "project";
  model: string | null;
  tools: string[] | null;
  promptPreview: string;
  alreadyImported: boolean;
};

export function ImportClient({ agents }: { agents: Item[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<"clone" | "reference">("reference");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function onImport() {
    if (selected.size === 0) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/agents/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ names: [...selected], mode }),
      });
      if (!res.ok) {
        alert("import failed");
        return;
      }
      const body = await res.json();
      setResult({ created: body.created.length, skipped: body.skipped.length });
      setSelected(new Set());
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium uppercase tracking-wide text-neutral-400">Import mode</label>
            <Select value={mode} onChange={(e) => setMode(e.target.value as "clone" | "reference")} className="mt-1">
              <option value="reference">Live reference (re-read the .md file on each run)</option>
              <option value="clone">Clone (one-time copy, editable in the panel)</option>
            </Select>
          </div>
          <Button onClick={onImport} disabled={busy || selected.size === 0}>
            {busy ? "Importing..." : `Import ${selected.size || ""}`.trim()}
          </Button>
        </div>
        {result && (
          <p className="mt-3 text-sm text-emerald-300">
            Imported {result.created}, skipped {result.skipped}.
          </p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {agents.map((a) => {
          const isSelected = selected.has(a.name);
          return (
            <Card
              key={a.name}
              className={`cursor-pointer transition ${isSelected ? "border-white bg-neutral-900/80" : "hover:border-neutral-700"}`}
            >
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={isSelected}
                  disabled={a.alreadyImported}
                  onChange={() => toggle(a.name)}
                />
                <div className="flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-sm font-semibold">{a.name}</div>
                    <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                      {a.scope}
                    </span>
                  </div>
                  {a.description && <p className="mt-1 text-xs text-neutral-400">{a.description}</p>}
                  <div className="mt-1 text-xs text-neutral-500">
                    {a.model ? `model: ${a.model}` : "model: default"} ·{" "}
                    {a.tools ? `${a.tools.length} tool${a.tools.length === 1 ? "" : "s"}` : "all tools"}
                  </div>
                  {a.alreadyImported && (
                    <div className="mt-2 text-xs text-amber-300">Already imported</div>
                  )}
                </div>
              </label>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
