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
// Set generously: code-using agents on big repos can legitimately take
// several minutes. Anything past this is almost always a hung subprocess.
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

// Use globalThis so the route handlers (which import this module from a
// different bundle in production) see the same `started` flag — same
// pattern as src/lib/prisma.ts and src/lib/scheduler.ts.
type WorkerGlobal = {
  workerStarted?: boolean;
  workerRunning?: boolean;
  /** taskId -> AbortController, populated while task is in flight.
   *  Used by /kill command to abort a running task externally. */
  workerAborters?: Map<string, AbortController>;
};
const globalForWorker = globalThis as unknown as WorkerGlobal;
const aborters = globalForWorker.workerAborters ?? new Map<string, AbortController>();
globalForWorker.workerAborters = aborters;

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
        // Need the step record to read its model/condition/parallelGroupId
        // overrides set by the orchestrator's dynamic workflows.
        run: { include: { workflow: { include: { steps: { orderBy: { order: "asc" } } } } } },
      },
    });
    return updated;
  });
}

/** Look up the WorkflowStep record for a given task. Returns null if
 *  the step doesn't exist (shouldn't happen in normal operation). */
function findStepForTask(task: { stepOrder: number; run: { workflow: { steps: Array<{ order: number; model: string | null }> } } }): { order: number; model: string | null } | null {
  return task.run.workflow.steps.find((s) => s.order === task.stepOrder) ?? null;
}

async function writeLog(taskId: string, runId: string, level: string, text: string) {
  await prisma.logLine.create({
    data: { taskId, level, text },
  });
  emitRunEvent(runId, { kind: "log", taskId, level, text, at: new Date().toISOString() });
}

/** Parse per-agent timeout override from tools JSON. */
function parseTimeoutMs(toolsJson: string | null): number {
  if (!toolsJson) return DEFAULT_TASK_TIMEOUT_MS;
  try {
    const t = JSON.parse(toolsJson) as { timeoutMs?: unknown };
    if (typeof t.timeoutMs === "number" && t.timeoutMs > 0 && t.timeoutMs < 60 * 60 * 1000) {
      return t.timeoutMs;
    }
  } catch {
    // ignore — invalid tools JSON falls back to default
  }
  return DEFAULT_TASK_TIMEOUT_MS;
}

/** Parse per-agent cwd override from tools JSON, for the safe-terminator git stash. */
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

/** Best-effort capture of half-written files when a task times out, so a
 *  later /se can recover them. Logs the stash ref to the task's error. */
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

/** Race the executor against a timeout. Registers the controller in
 *  the global aborters map so /kill can abort externally. */
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

/** Abort a running task externally (e.g., via /kill Telegram command).
 *  Returns true if a controller was found and aborted, false if task
 *  isn't currently in flight on this worker. */
export function killTask(taskId: string): boolean {
  const ctl = aborters.get(taskId);
  if (!ctl) return false;
  ctl.abort();
  return true;
}

/** List taskIds currently in flight (for /kill help). */
export function listInflightTaskIds(): string[] {
  return Array.from(aborters.keys());
}

async function processOne() {
  // Cost cap pre-flight — skip claiming if we're over today's budget.
  // Don't fail tasks; just don't pull more off the queue.
  try {
    await assertUnderCap();
  } catch (e) {
    if (e instanceof CostCapExceededError) {
      // Throttle the log so we don't spam every poll tick.
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

  const timeoutMs = parseTimeoutMs(task.agent.tools);
  let timedOut = false;

  try {
    const executor = getExecutor(task.agent.backend);
    // Per-step model override: if the WorkflowStep specifies its own
    // model (set by the orchestrator's dynamic plans), use that.
    // Otherwise fall back to the agent's default model.
    const step = findStepForTask(task);
    const effectiveModel = step?.model ?? task.agent.model;
    if (step?.model && step.model !== task.agent.model) {
      await writeLog(task.id, task.runId, "info", `model override: ${step.model} (agent default: ${task.agent.model})`);
    }
    const result = await runWithTimeout(task.id, async (signal) => {
      return executor({
        model: effectiveModel,
        systemPrompt: task.agent.systemPrompt,
        userInput: task.input,
        tools: task.agent.tools ? JSON.parse(task.agent.tools) : undefined,
        signal,
        onLog: (entry) => {
          void writeLog(task.id, task.runId, entry.level, entry.text);
        },
      });
    }, timeoutMs);

    const cost = computeCost(effectiveModel, result.tokensIn, result.tokensOut);
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
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);

    // AbortSignal-aborted fetches surface as a few different shapes.
    // Match common ones to recognize timeout vs other failures.
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

    await writeLog(task.id, task.runId, "error", message);
    await prisma.task.update({
      where: { id: task.id },
      data: {
        status: timedOut ? "timeout" : "failed",
        finishedAt: new Date(),
        error: message,
      },
    });
    emitRunEvent(task.runId, {
      kind: "task-status",
      taskId: task.id,
      status: timedOut ? "timeout" : "failed",
      stepOrder: task.stepOrder,
    });
    await failRun(task.runId, `step ${task.stepOrder} ${timedOut ? "timed out" : "failed"}: ${message}`);
  }
  return true;
}

let capLastLoggedStamp = 0;

async function loop() {
  if (globalForWorker.workerRunning) return;
  globalForWorker.workerRunning = true;
  try {
    while (await processOne()) {
      // drain
    }
  } finally {
    globalForWorker.workerRunning = false;
  }
}

export async function recoverInflight() {
  const stuck = await prisma.task.findMany({ where: { status: "running" } });
  for (const t of stuck) {
    await prisma.task.update({
      where: { id: t.id },
      data: { status: "failed", error: "worker restarted mid-run", finishedAt: new Date() },
    });
    await failRun(t.runId, "worker restarted while task was running");
  }
}

export function startWorker() {
  if (globalForWorker.workerStarted) return;
  globalForWorker.workerStarted = true;
  void recoverInflight().catch((e) => console.error("[worker] recovery failed", e));
  setInterval(() => {
    void loop().catch((e) => console.error("[worker] loop error", e));
  }, POLL_INTERVAL_MS);
  console.log("[worker] started");
}

/** Exposed for /api/health endpoint. */
export function workerStatus(): { started: boolean; running: boolean } {
  return {
    started: Boolean(globalForWorker.workerStarted),
    running: Boolean(globalForWorker.workerRunning),
  };
}
