// Dispatcher executor — the panel-side glue between an orchestrator's
// JSON plan output and actual specialist execution.
//
// This isn't an LLM call. It receives the orchestrator's text output,
// extracts the JSON plan, validates it, spawns a dynamic sub-workflow
// from the plan, awaits its completion, and returns a formatted
// summary of all sub-step outputs.
//
// Cost: zero LLM tokens for the dispatcher itself. Tokens are charged
// to the underlying specialist agents that the plan dispatches to.
//
// Failure modes:
//   - Output doesn't contain JSON → throws clear error with first 500
//     chars of the input so the founder can see what the orchestrator
//     said when debugging
//   - JSON invalid / fails validatePlan → throws with validation msg
//   - Sub-run times out (30 min default) → throws
//   - Sub-step fails → run still completes (status=failed), summary
//     shows the failure; orchestrator workflow continues to synthesis

import type { Executor } from "./types";
import { buildAndRun, awaitRunCompletion, validatePlan } from "../dynamic-workflow";

/** Extract the first balanced JSON object from a string. Handles
 *  markdown code fences (```json ... ```) and prose around the JSON. */
function extractJson(text: string): string | null {
  // Strip code fences if present
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1].trim();

  // Find first balanced { ... } chunk
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function formatTaskOutput(task: { stepOrder: number; status: string; output: string | null; error: string | null; agentId: string }, agentName: string): string {
  const head = `── step ${task.stepOrder} · ${agentName} · ${task.status} ──`;
  if (task.status === "failed" || task.status === "timeout") {
    return `${head}\nERROR: ${task.error ?? "(no error message)"}`;
  }
  if (task.status === "skipped") {
    return `${head}\n(${task.error ?? "skipped"})`;
  }
  return `${head}\n${task.output ?? "(no output)"}`;
}

export const dispatcherExecutor: Executor = async ({ userInput, onLog }) => {
  const json = extractJson(userInput);
  if (!json) {
    throw new Error(
      `dispatcher: orchestrator output did not contain JSON plan.\n\nFirst 500 chars:\n${userInput.slice(0, 500)}`,
    );
  }

  let plan;
  try {
    plan = validatePlan(JSON.parse(json));
  } catch (e) {
    throw new Error(
      `dispatcher: invalid plan — ${e instanceof Error ? e.message : String(e)}\n\nRaw JSON:\n${json.slice(0, 500)}`,
    );
  }

  onLog({
    level: "info",
    text: `dispatching ${plan.steps.length} step(s)${plan.reasoning ? ` — reasoning: ${plan.reasoning.slice(0, 200)}` : ""}`,
  });

  const { runId } = await buildAndRun(plan, { trigger: "telegram", label: "orch" });
  onLog({ level: "info", text: `sub-run ${runId} started, awaiting completion...` });

  const completed = await awaitRunCompletion(runId);

  // Build a structured summary that the synthesis step (or direct
  // telegram delivery) can consume. Include both raw outputs and
  // metadata so the synthesis prompt can decide what matters.
  const { prisma } = await import("../prisma");
  const agents = await prisma.agent.findMany({
    where: { id: { in: completed.tasks.map((t) => t.agentId) } },
    select: { id: true, name: true },
  });
  const agentName = new Map(agents.map((a) => [a.id, a.name]));

  const sections = completed.tasks.map((t) =>
    formatTaskOutput(t, agentName.get(t.agentId) ?? t.agentId),
  );
  const runStatus = completed.status;
  const totalCost = completed.totalCost;

  const summary = [
    `# Orchestrator sub-run result`,
    plan.reasoning ? `\n**Plan:** ${plan.reasoning}\n` : "",
    `**Run status:** ${runStatus}  ·  **Cost:** $${totalCost.toFixed(4)}`,
    "",
    ...sections,
  ]
    .filter(Boolean)
    .join("\n");

  return { output: summary, tokensIn: 0, tokensOut: 0 };
};
