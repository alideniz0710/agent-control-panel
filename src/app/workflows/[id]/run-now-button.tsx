"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";

export function RunNowButton({ workflowId }: { workflowId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const res = await fetch(`/api/workflows/${workflowId}/run`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? "failed to start run");
        return;
      }
      const body = await res.json();
      router.push(`/runs/${body.runId}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button onClick={run} disabled={busy}>
      {busy ? "Starting..." : "Run now"}
    </Button>
  );
}
