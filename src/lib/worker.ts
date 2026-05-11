import { exec as childExec } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "./prisma";
import { getExecutor } from "./executor";
import { computeCost } from "./pricing";
import { emitRunEvent } from "./events";
import { advanceAfterTask, failRun } from "./workflow";
import { assertUnderCap, CostCapExceededError } from "./cost-cap";

const execAsync = promisify(childExec);

const POLL_INTERVAL_MS = 2000;
// Default per-task wall-clock cap. Override per agent via tools.timeoutMs.
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

// Concurrency cap. 3 is the sweet spot for the orchestrator pattern:
//   slot 1: dispatcher (blocks waiting for sub-run)
//   slot 2-3: sub-tasks of the dispatched plan
// Override via MAX_CONCURRENT_TASKS env. Set generously high enough to
// avoid dispatcher-starves-sub-task deadlock; the Anthropic API will
// rate-limit before the worker itself becomes a bottleneck.
const MAX_CONCURRENT_TASKS = (() => {
  const raw = process.env.MAX_CONCURRENT_TASKS;
  if (!raw) return 3;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 3;
  return Math.min(n, 16); // sanity cap
})();

// Use globalThis so route handlers (which import this module from a
// different bundle in production) see the same state — same pattern
// as src/lib/prisma.ts and src/lib/scheduler.ts.
type WorkerGlobal = {
  workerStarted?: boolean;
  /** taskId -> AbortController for in-flight tasks. Size = inflight count
   *  AND used by /kill to abort externally. */
  workerAborters?: Map<string, AbortController>;
};
const globalForWorker = globalThis as unknown as WorkerGlobal;
const aborters = globalForWorker.workerAborters ?? new Map<string, AbortController>();
globalForWorker.workerAborters = aborters;

// ── helpers ────────────────────────────────────────────────────────────

async function claimNextTask() {
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.findFirst({
      where: { status: "queued" },
      orderBy: [{ run: { startedAt: "asc" } }, { stepOrder: "asc" }],
    });
    if (!task) return null;
    const updated = await tx.task.update({
      where: { id: task.id },
      data: { status: "running", startedAt: new Date() },
      include: {
        agent: true,
        run: { include: { workflow: { include: { steps: { orderBy: { order: "asc" } } } } } },
      },
    });
    return updated;
  });
}

type ClaimedTask = NonNullable<Awaited<ReturnType<typeof claimNextTask>>>;

/** Look up the WorkflowStep record for a given task. */
function findStepForTask(task: { stepOrder: number; run: { workflow: { steps: Array<{ order: number; model: string | null }> } } }): { order: number; model: string | null } | null {
  return task.run.workflow.steps.find((s) => s.order === task.stepOrder) ?? null;
}

async function writeLog(taskId: string, runId: string, level: string, text: string) {
  await prisma.logLine.create({ data: { taskId, level, text } });
  emitRunEvent(runId, { kind: "log", taskId, level, text, at: new Date().toISOString() });
}

function parseTimeoutMs(toolsJson: string | null): number {
  if (!toolsJson) return DEFAULT_TASK_TIMEOUT_MS;
  try {
    const t = JSON.parse(toolsJson) as { timeoutMs?: unknown };
    if (typeof t.timeoutMs === "number" && t.timeoutMs > 0 && t.timeoutMs < 60 * 60 * 1000) {
      return t.timeoutMs;
    }
  } catch {
    // ignore
  }
  return DEFAULT_TASK_TIMEOUT_MS;
}

function parseCwd(toolsJson: string | null): string | null {
  if (!toolsJson) return null;
  try {
    const t = JSON.parse(toolsJson) as { cwd?: unknown };
    if (typeof t.cwd === "string" && t.cwd.length > 0) return t.cwd;
  } catch {
    // ignore
  }
  return null;
}

async function safeStashOnTimeout(taskId: string, runId: string, cwd: string | null): Promise<string | null> {
  if (!cwd) return null;
  try {
    const stashMsg = `panel-timeout-${taskId}-${Date.now()}`;
    const { stdout, stderr } = await execAsync(
      `cd "${cwd}" && git stash push --include-untracked -m "${stashMsg}" 2>&1 || true`,
      { timeout: 10_000 },
    );
    const out = (stdout + stderr).trim();
    await writeLog(taskId, runId, "info", `safe-stash on timeout: ${out.slice(0, 200)}`);
    return stashMsg;
  } catch (e) {
    await writeLog(taskId, runId, "info", `safe-stash failed: ${e instanceof Error ? e.message : String(e)}`).catch(() => undefined);
    return null;
  }
}

async function runWithTimeout<T>(
  taskId: string,
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  aborters.set(taskId, controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    aborters.delete(taskId);
  }
}

export function killTask(taskId: string): boolean {
  const ctl = aborters.get(taskId);
  if (!ctl) return false;
  ctl.abort();
  return true;
}

export function listInflightTaskIds(): string[] {
  return Array.from(aborters.keys());
}

// ── execution ──────────────────────────────────────────────────────────

let capLastLoggedStamp = 0;

/** Smart model fallback ladder. If a Claude model times out or returns
 *  5xx/529 (overloaded), one retry happens with the next-tier model.
 *  Only Claude models in this ladder; other providers (OpenRouter, etc.)
 *  don't fall back here. */
const FALLBACK_LADDER: Record<string, string> = {
  "claude-haiku-4-5": "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001": "claude-sonnet-4-6",
  "claude-sonnet-4-6": "claude-opus-4-7",
  "claude-sonnet-4-5": "claude-opus-4-7",
};

function nextTierModel(model: string): string | null {
  return FALLBACK_LADDER[model] ?? null;
}

/** Heuristic: should this error trigger a model-fallback retry? */
function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  const msg = err.message.toLowerCase();
  if (msg.includes("aborted")) return true;
  if (msg.includes("the operation was aborted")) return true;
  // Anthropic-side overload / rate
  if (msg.includes("529") || msg.includes("overloaded")) return true;
  if (msg.includes("502") || msg.includes("503") || msg.includes("504")) return true;
  if (msg.includes("rate_limit") || msg.includes("rate limit")) return true;
  if (msg.includes("fetch failed")) return true;
  return false;
}

/** Run a single claimed task. Doesn't throw — all failure paths update
 *  the DB and mark the run failed via failRun(). Loops over the task's
 *  lifecycle: run executor with timeout (with optional model fallback),
 *  update task on done/failed, cascade to advanceAfterTask. */
async function executeTask(task: ClaimedTask): Promise<void> {
  const timeoutMs = parseTimeoutMs(task.agent.tools);
  let timedOut = false;

  const executor = getExecutor(task.agent.backend);
  const step = findStepForTask(task);
  const initialModel = step?.model ?? task.agent.model;
  if (step?.model && step.model !== task.agent.model) {
    await writeLog(task.id, task.runId, "info", `model override: ${step.model} (agent default: ${task.agent.model})`);
  }
  const tools = task.agent.tools ? JSON.parse(task.agent.tools) : undefined;

  // Try sequence: [initial, fallback?]. fallback only attempted once and
  // only if the error looks retryable AND a higher-tier model is in the
  // ladder.
  const attemptModels: string[] = [initialModel];
  const fallback = nextTierModel(initialModel);
  if (fallback) attemptModels.push(fallback);

  let lastErr: unknown = null;
  let succeeded = false;
  let result: { output: string; tokensIn: number; tokensOut: number } | null = null;
  let usedModel = initialModel;

  for (let i = 0; i < attemptModels.length; i++) {
    const tryModel = attemptModels[i];
    try {
      result = await runWithTimeout(task.id, async (signal) => {
        return executor({
          model: tryModel,
          systemPrompt: task.agent.systemPrompt,
          userInput: task.input,
          tools,
          signal,
          onLog: (entry) => {
            void writeLog(task.id, task.runId, entry.level, entry.text);
          },
        });
      }, timeoutMs);
      usedModel = tryModel;
      succeeded = true;
      break;
    } catch (err) {
      lastErr = err;
      // If we have a next attempt to try AND the error is retryable, log and continue.
      const hasNext = i < attemptModels.length - 1;
      if (hasNext && isRetryableError(err)) {
        const next = attemptModels[i + 1];
        await writeLog(
          task.id,
          task.runId,
          "info",
          `fallback: ${tryModel} failed (${err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100)}), retrying with ${next}`,
        );
        continue;
      }
      // No more attempts or error not retryable: fall through to failure handling.
      break;
    }
  }

  if (succeeded && result) {
    const cost = computeCost(usedModel, result.tokensIn, result.tokensOut);
    await prisma.task.update({
      where: { id: task.id },
      data: {
        status: "done",
        finishedAt: new Date(),
        output: result.output,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        cost,
      },
    });
    emitRunEvent(task.runId, {
      kind: "task-done",
      taskId: task.id,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      cost,
      output: result.output,
    });
    await advanceAfterTask(task.id, result.output);
    return;
  }

  // Failure path
  const err = lastErr;
  let message = err instanceof Error ? err.message : String(err);
  const errName = err instanceof Error ? err.name : "";
  if (
    errName === "AbortError" ||
    message.toLowerCase().includes("aborted") ||
    message.toLowerCase().includes("the operation was aborted")
  ) {
    timedOut = true;
    message = `task timed out after ${Math.round(timeoutMs / 1000)}s`;
    const cwd = parseCwd(task.agent.tools);
    const stashRef = await safeStashOnTimeout(task.id, task.runId, cwd);
    if (stashRef) {
      message += ` (working tree captured to git stash: ${stashRef})`;
    }
  }
  if (attemptModels.length > 1) {
    message = `${message} (after trying: ${attemptModels.join(" → ")})`;
  }

  await writeLog(task.id, task.runId, "error", message).catch(() => undefined);
  await prisma.task.update({
    where: { id: task.id },
    data: {
      status: timedOut ? "timeout" : "failed",
      finishedAt: new Date(),
      error: message,
    },
  }).catch(() => undefined);
  emitRunEvent(task.runId, {
    kind: "task-status",
    taskId: task.id,
    status: timedOut ? "timeout" : "failed",
    stepOrder: task.stepOrder,
  });
  await failRun(task.runId, `step ${task.stepOrder} ${timedOut ? "timed out" : "failed"}: ${message}`).catch(() => undefined);
}

/** Try to claim and START (fire-and-forget) one queued task. Returns
 *  true if a task was started, false if nothing to start (queue empty,
 *  cap hit, or concurrency exhausted). */
async function tryClaimAndStart(): Promise<boolean> {
  // Cost cap pre-flight — skip claiming if over today's budget. Throttle
  // the log so we don't spam every poll tick.
  try {
    await assertUnderCap();
  } catch (e) {
    if (e instanceof CostCapExceededError) {
      const stamp = Math.floor(Date.now() / 60_000);
      if (stamp !== capLastLoggedStamp) {
        capLastLoggedStamp = stamp;
        console.warn(`[worker] ${e.message}; pausing task pulls`);
      }
      return false;
    }
    throw e;
  }

  const task = await claimNextTask();
  if (!task) return false;

  emitRunEvent(task.runId, {
    kind: "task-status",
    taskId: task.id,
    status: "running",
    stepOrder: task.stepOrder,
  });

  // Fire and forget — DON'T await. This is the key to parallelism: the
  // tryClaimAndStart caller can immediately claim another task while
  // this one runs in the background. AbortController registration
  // happens inside runWithTimeout, so aborters.size bumps right after
  // executeTask starts and decrements in its finally.
  void executeTask(task).catch((e) =>
    console.error(`[worker] executeTask ${task.id} unexpected error:`, e),
  );

  return true;
}

/** Poll tick: claim and start up to MAX_CONCURRENT_TASKS tasks. */
async function loop(): Promise<void> {
  // No re-entry guard needed — each call only tries to fill empty slots.
  // If a previous tick is still claiming, aborters.size will have been
  // bumped by it (via executeTask) and this tick will see the right count.
  while (aborters.size < MAX_CONCURRENT_TASKS) {
    const started = await tryClaimAndStart();
    if (!started) break;
  }
}

// ── recovery + lifecycle ──────────────────────────────────────────────

export async function recoverInflight() {
  // Mark any task that was "running" before this process started as
  // failed (its worker died mid-execution).
  const stuck = await prisma.task.findMany({ where: { status: "running" } });
  for (const t of stuck) {
    await prisma.task.update({
      where: { id: t.id },
      data: { status: "failed", error: "worker restarted mid-run", finishedAt: new Date() },
    });
    await failRun(t.runId, "worker restarted while task was running");
  }
  // Also clean up runs that have NO running task but somehow have status
  // "running" with all child tasks in terminal states OR queued/pending
  // that depend on a failed step. The dispatcher deadlock can leave runs
  // in this state — easier to nuke them here than reason about every path.
  const stuckRuns = await prisma.run.findMany({
    where: { status: "running" },
    include: { tasks: true },
  });
  for (const run of stuckRuns) {
    const hasRunning = run.tasks.some((t) => t.status === "running");
    if (hasRunning) continue; // active, leave alone
    const allTerminalOrIdle = run.tasks.every(
      (t) =>
        t.status === "done" ||
        t.status === "failed" ||
        t.status === "timeout" ||
        t.status === "skipped" ||
        t.status === "queued" ||
        t.status === "pending" ||
        t.status === "awaiting_approval",
    );
    if (!allTerminalOrIdle) continue;
    // If any task is failed/timeout, mark run failed. If all are done, mark done.
    // If still has queued/pending/awaiting, leave it (worker will pick up).
    const hasFailed = run.tasks.some((t) => t.status === "failed" || t.status === "timeout");
    const hasIdle = run.tasks.some((t) => t.status === "queued" || t.status === "pending" || t.status === "awaiting_approval");
    if (hasFailed && !hasIdle) {
      await prisma.run.update({
        where: { id: run.id },
        data: { status: "failed", finishedAt: new Date(), error: "recovered: tasks failed, no active path" },
      });
    }
  }
}

export function startWorker() {
  if (globalForWorker.workerStarted) return;
  globalForWorker.workerStarted = true;
  void recoverInflight().catch((e) => console.error("[worker] recovery failed", e));
  setInterval(() => {
    void loop().catch((e) => console.error("[worker] loop error", e));
  }, POLL_INTERVAL_MS);
  console.log(`[worker] started (max concurrent: ${MAX_CONCURRENT_TASKS})`);
}

/** Exposed for /api/health endpoint. */
export function workerStatus(): {
  started: boolean;
  inFlight: number;
  maxConcurrent: number;
} {
  return {
    started: Boolean(globalForWorker.workerStarted),
    inFlight: aborters.size,
    maxConcurrent: MAX_CONCURRENT_TASKS,
  };
}
