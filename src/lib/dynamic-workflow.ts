// Dynamic (ephemeral) workflow execution.
//
// Unlike workflows defined in the DB and triggered by name, a dynamic
// workflow is built on the fly from a JSON plan (typically produced by
// the orchestrator agent) and run immediately. The plan defines its
// steps with explicit agent + model + input + optional conditional /
// parallel grouping.
//
// Why a separate path: the orchestrator's role is to figure out how
// to handle a user's plain-language request. Pre-defining a workflow
// for every possible orchestrator output would be impossible. Instead
// we treat the workflow shape as the orchestrator's output format.
//
// Implementation: we still create a Workflow row in the DB so that
// the standard worker + advanceAfterTask logic Just Works™. The row
// is named "dyn-<random>" so it's easy to identify and clean up.
// Tagging via the regular workflow trigger="orchestrator" so cost
// accounting + UI listings work.
//
// Lifecycle:
//   buildAndRun(plan, parentChatId?) → { runId }
//     creates a Workflow record + WorkflowStep records (one per plan
//     step) + a Run + initial Tasks, returns runId. Caller can poll
//     prisma.run.findUnique({where:{id}}) to await completion, or
//     hook into emitRunEvent in events.ts.

import { prisma } from "./prisma";
import { startRun } from "./workflow";

export interface DynamicStep {
  agentName: string;          // e.g. "cc:software-engineer"
  model?: string | null;      // optional override
  task: string;               // input for the agent
  condition?: string | null;  // substring of prior output that must match for step to run
  parallelGroupId?: string | null;  // steps with same id run concurrently (Day 5)
  requiresApproval?: boolean;
}

export interface DynamicPlan {
  reasoning?: string;
  estimatedCostUsd?: number;
  steps: DynamicStep[];
}

export interface BuildAndRunOptions {
  /** Trigger tag — defaults to "orchestrator" for visibility in run lists. */
  trigger?: "manual" | "scheduled" | "webhook" | "telegram";
  /** Telegram chat id, if this dynamic workflow is driven by a Telegram message. */
  chatId?: string;
  /** Telegram command tag, e.g. "orchestrator". */
  telegramCommand?: string;
  /** A friendly name suffix for the ephemeral workflow row. */
  label?: string;
}

export interface DynamicRunHandle {
  runId: string;
  workflowId: string;
}

/** Validates a dynamic plan and throws descriptive errors. */
export function validatePlan(plan: unknown): DynamicPlan {
  if (!plan || typeof plan !== "object") {
    throw new Error("plan must be an object");
  }
  const p = plan as Record<string, unknown>;
  if (!Array.isArray(p.steps)) {
    throw new Error("plan.steps must be an array");
  }
  const steps = p.steps as Array<Record<string, unknown>>;
  if (steps.length === 0) {
    throw new Error("plan.steps must have at least 1 entry");
  }
  if (steps.length > 8) {
    throw new Error(`plan.steps too long (${steps.length}); orchestrator should plan in chunks of ≤8`);
  }
  const validated: DynamicStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const agentName = typeof s.agentName === "string" ? s.agentName : typeof s.agent_name === "string" ? s.agent_name : null;
    if (!agentName) throw new Error(`step[${i}].agentName missing`);
    const task = typeof s.task === "string" ? s.task : null;
    if (!task) throw new Error(`step[${i}].task missing`);
    validated.push({
      agentName,
      model: typeof s.model === "string" ? s.model : null,
      task,
      condition: typeof s.condition === "string" ? s.condition : null,
      parallelGroupId:
        typeof s.parallelGroupId === "string"
          ? s.parallelGroupId
          : typeof s.parallel_group_id === "string"
          ? s.parallel_group_id
          : null,
      requiresApproval: Boolean(s.requiresApproval ?? false),
    });
  }
  return {
    reasoning: typeof p.reasoning === "string" ? p.reasoning : undefined,
    estimatedCostUsd: typeof p.estimatedCostUsd === "number" ? p.estimatedCostUsd : typeof p.estimated_cost_usd === "number" ? p.estimated_cost_usd : undefined,
    steps: validated,
  };
}

/** Persists an ephemeral Workflow + Steps and triggers a Run. */
export async function buildAndRun(
  plan: DynamicPlan,
  opts: BuildAndRunOptions = {},
): Promise<DynamicRunHandle> {
  // Resolve all agentName references to agent IDs in one query.
  const agentNames = Array.from(new Set(plan.steps.map((s) => s.agentName)));
  const agents = await prisma.agent.findMany({
    where: { name: { in: agentNames } },
  });
  const byName = new Map(agents.map((a) => [a.name, a]));
  const missing = agentNames.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    throw new Error(`unknown agents in plan: ${missing.join(", ")}`);
  }

  // Random workflow name for the ephemeral row.
  const rand = Math.random().toString(36).slice(2, 8);
  const label = opts.label ? `-${opts.label}` : "";
  const workflowName = `dyn${label}-${rand}`;

  const workflow = await prisma.workflow.create({
    data: {
      name: workflowName,
      enabled: true,
      schedule: null,
      steps: {
        create: plan.steps.map((s, i) => ({
          order: i,
          agentId: byName.get(s.agentName)!.id,
          inputTemplate: s.task,
          requiresApproval: s.requiresApproval ?? false,
          model: s.model ?? null,
          condition: s.condition ?? null,
          parallelGroupId: s.parallelGroupId ?? null,
        })),
      },
    },
  });

  // The first step's input is the literal task from the plan (already
  // baked into inputTemplate), so we don't pass firstInput here — the
  // default startRun behavior will pick up the template as-is.
  const runId = await startRun(
    workflow.id,
    opts.trigger ?? "telegram",
    undefined,
    { chatId: opts.chatId, telegramCommand: opts.telegramCommand },
  );
  return { runId, workflowId: workflow.id };
}

/** Wait for a run to reach a terminal state. Polls every `intervalMs`.
 *  Returns the run record with all tasks loaded. */
export async function awaitRunCompletion(runId: string, opts: { intervalMs?: number; timeoutMs?: number } = {}) {
  const interval = opts.intervalMs ?? 1500;
  const timeout = opts.timeoutMs ?? 30 * 60 * 1000; // 30 min max
  const start = Date.now();
  for (;;) {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      include: { tasks: { orderBy: { stepOrder: "asc" } } },
    });
    if (!run) throw new Error(`run not found: ${runId}`);
    if (run.status === "done" || run.status === "failed") return run;
    if (Date.now() - start > timeout) {
      throw new Error(`run ${runId} did not complete within ${timeout}ms (status: ${run.status})`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
