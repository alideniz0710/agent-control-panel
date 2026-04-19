import { prisma } from "./prisma";
import { getExecutor } from "./executor";
import { computeCost } from "./pricing";
import { emitRunEvent } from "./events";
import { advanceAfterTask, failRun } from "./workflow";

const POLL_INTERVAL_MS = 2000;

let started = false;
let running = false;

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
      include: { agent: true },
    });
    return updated;
  });
}

async function writeLog(taskId: string, runId: string, level: string, text: string) {
  await prisma.logLine.create({
    data: { taskId, level, text },
  });
  emitRunEvent(runId, { kind: "log", taskId, level, text, at: new Date().toISOString() });
}

async function processOne() {
  const task = await claimNextTask();
  if (!task) return false;

  emitRunEvent(task.runId, {
    kind: "task-status",
    taskId: task.id,
    status: "running",
    stepOrder: task.stepOrder,
  });

  try {
    const executor = getExecutor(task.agent.backend);
    const result = await executor({
      model: task.agent.model,
      systemPrompt: task.agent.systemPrompt,
      userInput: task.input,
      tools: task.agent.tools ? JSON.parse(task.agent.tools) : undefined,
      onLog: (entry) => {
        void writeLog(task.id, task.runId, entry.level, entry.text);
      },
    });
    const cost = computeCost(task.agent.model, result.tokensIn, result.tokensOut);
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
    const message = err instanceof Error ? err.message : String(err);
    await writeLog(task.id, task.runId, "error", message);
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "failed", finishedAt: new Date(), error: message },
    });
    emitRunEvent(task.runId, {
      kind: "task-status",
      taskId: task.id,
      status: "failed",
      stepOrder: task.stepOrder,
    });
    await failRun(task.runId, `step ${task.stepOrder} failed: ${message}`);
  }
  return true;
}

async function loop() {
  if (running) return;
  running = true;
  try {
    while (await processOne()) {
      // drain
    }
  } finally {
    running = false;
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
  if (started) return;
  started = true;
  void recoverInflight().catch((e) => console.error("[worker] recovery failed", e));
  setInterval(() => {
    void loop().catch((e) => console.error("[worker] loop error", e));
  }, POLL_INTERVAL_MS);
  console.log("[worker] started");
}
