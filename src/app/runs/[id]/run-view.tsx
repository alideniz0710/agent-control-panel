"use client";

import { useEffect, useState } from "react";
import { Button, Card, StatusBadge, formatCost } from "@/components/ui";

type LogLine = { level: string; text: string; at: string };
type TaskView = {
  id: string;
  stepOrder: number;
  status: string;
  input: string;
  output: string | null;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  error: string | null;
  agentName: string;
  agentModel: string;
  logs: LogLine[];
};
type RunViewState = {
  id: string;
  status: string;
  workflowName: string;
  trigger: string;
  totalCost: number;
  tasks: TaskView[];
};

type StreamEvent =
  | { kind: "hello"; runId: string }
  | { kind: "log"; taskId: string; level: string; text: string; at: string }
  | { kind: "task-status"; taskId: string; status: string; stepOrder: number }
  | { kind: "run-status"; runId: string; status: string }
  | { kind: "task-done"; taskId: string; tokensIn: number; tokensOut: number; cost: number; output: string | null };

export function RunView({ initial }: { initial: RunViewState }) {
  const [state, setState] = useState<RunViewState>(initial);

  useEffect(() => {
    const es = new EventSource(`/api/runs/${initial.id}/stream`);
    es.onmessage = (evt) => {
      if (!evt.data) return;
      let parsed: StreamEvent;
      try {
        parsed = JSON.parse(evt.data) as StreamEvent;
      } catch {
        return;
      }
      setState((prev) => applyEvent(prev, parsed));
    };
    es.onerror = () => {
      /* auto-reconnects */
    };
    return () => es.close();
  }, [initial.id]);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-neutral-400">Status</div>
            <div className="mt-1">
              <StatusBadge status={state.status} />
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm text-neutral-400">Total cost</div>
            <div className="text-xl font-semibold">{formatCost(totalCost(state))}</div>
          </div>
        </div>
      </Card>

      {state.tasks.map((t) => (
        <TaskCard key={t.id} task={t} />
      ))}
    </div>
  );
}

function totalCost(state: RunViewState): number {
  return state.tasks.reduce((sum, t) => sum + t.cost, 0);
}

function TaskCard({ task }: { task: TaskView }) {
  const [busy, setBusy] = useState(false);

  async function approve() {
    setBusy(true);
    try {
      await fetch(`/api/tasks/${task.id}/approve`, { method: "POST" });
    } finally {
      setBusy(false);
    }
  }
  async function reject() {
    const reason = prompt("Reason for rejection?") ?? "rejected";
    setBusy(true);
    try {
      await fetch(`/api/tasks/${task.id}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-neutral-500">Step {task.stepOrder + 1}</div>
          <div className="mt-0.5 text-sm font-semibold">
            {task.agentName} <span className="font-mono text-xs text-neutral-500">· {task.agentModel}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {task.cost > 0 && (
            <span className="text-xs text-neutral-500">
              {task.tokensIn}/{task.tokensOut} · {formatCost(task.cost)}
            </span>
          )}
          <StatusBadge status={task.status} />
        </div>
      </div>

      {task.status === "awaiting_approval" && (
        <div className="mt-3 flex items-center gap-2 rounded border border-purple-500/30 bg-purple-500/10 p-2 text-sm">
          <span className="flex-1 text-purple-200">This step needs your approval to run.</span>
          <Button onClick={approve} disabled={busy}>
            Approve
          </Button>
          <Button variant="danger" onClick={reject} disabled={busy}>
            Reject
          </Button>
        </div>
      )}

      <details className="mt-3" open={task.status === "running" || task.status === "awaiting_approval" || !!task.error}>
        <summary className="cursor-pointer text-xs text-neutral-400">
          Input & logs
        </summary>
        <div className="mt-2 space-y-2">
          <div>
            <div className="mb-1 text-xs text-neutral-500">Input</div>
            <pre className="max-h-40 overflow-auto rounded bg-neutral-950 p-2 text-xs whitespace-pre-wrap">
              {task.input || "—"}
            </pre>
          </div>
          {task.logs.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-neutral-500">Live log</div>
              <pre className="max-h-60 overflow-auto rounded bg-neutral-950 p-2 text-xs whitespace-pre-wrap font-mono">
                {task.logs.map((l, i) => (
                  <div key={i} className={logClass(l.level)}>
                    {l.text}
                  </div>
                ))}
              </pre>
            </div>
          )}
          {task.output && (
            <div>
              <div className="mb-1 text-xs text-neutral-500">Output</div>
              <pre className="max-h-60 overflow-auto rounded bg-neutral-950 p-2 text-xs whitespace-pre-wrap">
                {task.output}
              </pre>
            </div>
          )}
          {task.error && (
            <div>
              <div className="mb-1 text-xs text-red-400">Error</div>
              <pre className="rounded bg-red-950/40 p-2 text-xs text-red-200 whitespace-pre-wrap">{task.error}</pre>
            </div>
          )}
        </div>
      </details>
    </Card>
  );
}

function logClass(level: string): string {
  if (level === "error") return "text-red-300";
  if (level === "tool") return "text-amber-300";
  if (level === "info") return "text-neutral-400";
  return "text-neutral-100";
}

function applyEvent(state: RunViewState, event: StreamEvent): RunViewState {
  if (event.kind === "run-status") {
    return { ...state, status: event.status };
  }
  if (event.kind === "task-status") {
    return {
      ...state,
      tasks: state.tasks.map((t) => (t.id === event.taskId ? { ...t, status: event.status } : t)),
    };
  }
  if (event.kind === "log") {
    return {
      ...state,
      tasks: state.tasks.map((t) =>
        t.id === event.taskId
          ? { ...t, logs: [...t.logs, { level: event.level, text: event.text, at: event.at }] }
          : t,
      ),
    };
  }
  if (event.kind === "task-done") {
    return {
      ...state,
      tasks: state.tasks.map((t) =>
        t.id === event.taskId
          ? {
              ...t,
              status: "done",
              tokensIn: event.tokensIn,
              tokensOut: event.tokensOut,
              cost: event.cost,
              output: event.output,
            }
          : t,
      ),
    };
  }
  return state;
}
