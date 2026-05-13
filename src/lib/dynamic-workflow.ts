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

// Agent-specific guardrails appended to every task the orchestrator
// hands off via buildAndRun. Centralizes "always do this" rules so
// individual orchestrator-router decisions don't have to remember
// them. Empirically the founder reports:
//   - Agents giving long technical responses (founder isn't a dev)
//   - Agents forgetting [S]/[no-test] in PR titles → auto-merge skips
//   - Agents not writing test steps in PR descriptions
// Suffix is appended after the orchestrator's task text; it's idempotent
// (re-appending doesn't break anything) and only fires for agent names
// we explicitly target.
const AGENT_TASK_GUARDRAILS: Record<string, string> = {
  "cc:software-engineer":
    "\n\n---\n\n**Cevap kuralları (zorunlu):**\n" +
    "- Türkçe yaz, maksimum 5 satır özet. Detay sadece kullanıcı tekrar sorarsa.\n" +
    "- PR açıyorsan title formatı: `[S] kısa açıklama [no-test]`\n" +
    "  - Test eklediysen [no-test] yazma\n" +
    "  - Boyut bilmiyorsan [S] kullan\n" +
    "- PR description'a şu başlık zorunlu:\n" +
    "  ```\n" +
    "  ## Telefon test adımları\n" +
    "  1. <Vercel preview URL>\n" +
    "  2. <ne tıkla / ne gir>\n" +
    "  3. <beklenen sonuç>\n" +
    "  ```\n" +
    "- middleware, .env, package.json, migration dosyalarına dokunma — auto-merge deny-list.",
  "cc:debug":
    "\n\n---\n\n**Cevap kuralları (zorunlu):**\n" +
    "- Türkçe yaz, maksimum 5 satır özet.\n" +
    "- Root cause + tek paragraf fix tarifi yeter.\n" +
    "- PR açıyorsan title formatı: `[S] fix: kısa [no-test]` (test eklediysen [no-test] yazma).",
  "cc:personal-assistant":
    "\n\n---\n\n**Cevap kuralları (zorunlu):**\n" +
    "- Türkçe yaz, maksimum 200 satır markdown.\n" +
    "- Kod yazma; plain text + markdown listeleri/tablolar yeter.\n" +
    "- Mesajı doğrudan Telegram'a yapıştırılabilir formatta tut.",
};

// Model auto-selection based on size tag in task text.
// Convention: orchestrator-router agents (and the founder via /se prompt)
// include a size tag like "[S]" or "[M]" or "[L]" in the task / PR
// title. We detect that tag and route to a cost-appropriate model:
//   [XS] / [S]  → Haiku (cheapest, ~$1 input / $5 output per Mtok)
//   [M]         → Sonnet (default, ~$3 / $15)
//   [L]         → Opus (heavy lifting, ~$15 / $75)
// If no tag is found, we DON'T override — the agent's configured
// model stands. This is conservative: an explicit step.model from
// the orchestrator always wins.
const SIZE_TAG_RE = /\[(XS|S|M|L)\]/i;

function modelForSizeTag(tag: string): string | null {
  switch (tag.toUpperCase()) {
    case "XS":
    case "S":
      return "claude-haiku-4-5-20251001";
    case "M":
      return null; // keep agent's default (Sonnet)
    case "L":
      return "claude-opus-4-7";
    default:
      return null;
  }
}

/** Detect a size tag in the task text and pick a cheaper/heavier model
 *  for the step. Returns null when no override should be applied
 *  (no tag, or [M] which means "use default"). */
export function pickModelFromSizeTag(taskText: string): string | null {
  const m = taskText.match(SIZE_TAG_RE);
  if (!m) return null;
  return modelForSizeTag(m[1]);
}

/** Append agent-specific response-style + PR-format guardrails to a
 *  task string. Idempotent. Used by buildAndRun (orchestrator path)
 *  and telegram-poller (direct /se /debug /pa path). */
export function applyGuardrails(agentName: string, task: string): string {
  const suffix = AGENT_TASK_GUARDRAILS[agentName];
  if (!suffix) return task;
  // Idempotent — don't double-append if orchestrator already merged it in
  if (task.includes("**Cevap kuralları (zorunlu):**")) return task;
  return task + suffix;
}

/** Combined task preparation: prepend memory context (from memory/
 *  filesystem) AND append response-style guardrails. The two are
 *  orthogonal — guardrails govern OUTPUT behavior, memory provides
 *  INPUT context. Both prepended at task creation time, so updates to
 *  memory.md files take effect on the NEXT dispatched task. */
export async function prepareTaskInput(agentName: string, task: string): Promise<string> {
  // Local import to avoid a circular dep when memory.ts grows to need
  // anything from this file later.
  const { buildMemoryContext } = await import("./memory");
  const withGuardrails = applyGuardrails(agentName, task);
  const memoryPrefix = await buildMemoryContext(agentName);
  return memoryPrefix + withGuardrails;
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
        // Each step's input is prepared (memory + guardrails) async, so we
        // resolve all of them in parallel before passing to Prisma's create.
        // model resolution priority:
        //   1. explicit step.model from the orchestrator's plan
        //   2. size-tag auto-selection (XS/S → Haiku, L → Opus)
        //   3. null → agent's default model (Sonnet)
        create: await Promise.all(
          plan.steps.map(async (s, i) => {
            const autoModel = s.model ? null : pickModelFromSizeTag(s.task);
            return {
              order: i,
              agentId: byName.get(s.agentName)!.id,
              inputTemplate: await prepareTaskInput(s.agentName, s.task),
              requiresApproval: s.requiresApproval ?? false,
              model: s.model ?? autoModel,
              condition: s.condition ?? null,
              parallelGroupId: s.parallelGroupId ?? null,
            };
          }),
        ),
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
