import { prisma } from "./prisma";
import { emitRunEvent } from "./events";

export async function startRun(workflowId: string, trigger: "manual" | "scheduled"): Promise<string> {
  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!workflow) throw new Error("workflow not found");
  if (workflow.steps.length === 0) throw new Error("workflow has no steps");

  const run = await prisma.run.create({
    data: {
      workflowId,
      status: "running",
      trigger,
      tasks: {
        create: workflow.steps.map((s, idx) => ({
          stepOrder: s.order,
          agentId: s.agentId,
          status: idx === 0
            ? s.requiresApproval ? "awaiting_approval" : "queued"
            : "pending",
          input: idx === 0 ? s.inputTemplate : "",
        })),
      },
    },
    include: { tasks: { orderBy: { stepOrder: "asc" } } },
  });

  emitRunEvent(run.id, { kind: "run-status", runId: run.id, status: run.status });
  const first = run.tasks[0];
  emitRunEvent(run.id, { kind: "task-status", taskId: first.id, status: first.status, stepOrder: first.stepOrder });
  return run.id;
}

export async function advanceAfterTask(taskId: string, output: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { run: { include: { workflow: { include: { steps: { orderBy: { order: "asc" } } } }, tasks: { orderBy: { stepOrder: "asc" } } } } },
  });
  if (!task) return;

  const nextTask = task.run.tasks.find((t) => t.stepOrder > task.stepOrder);
  if (!nextTask) {
    const totalCost = task.run.tasks.reduce((sum, t) => sum + (t.id === taskId ? 0 : t.cost), 0);
    await prisma.run.update({
      where: { id: task.runId },
      data: { status: "done", finishedAt: new Date(), totalCost: totalCost + task.cost },
    });
    emitRunEvent(task.runId, { kind: "run-status", runId: task.runId, status: "done" });
    return;
  }

  const step = task.run.workflow.steps.find((s) => s.order === nextTask.stepOrder);
  if (!step) return;

  const rendered = step.inputTemplate.replace(/\{\{\s*previousOutput\s*\}\}/g, output);
  const newStatus = step.requiresApproval ? "awaiting_approval" : "queued";

  await prisma.task.update({
    where: { id: nextTask.id },
    data: { status: newStatus, input: rendered },
  });
  emitRunEvent(task.runId, { kind: "task-status", taskId: nextTask.id, status: newStatus, stepOrder: nextTask.stepOrder });
}

export async function failRun(runId: string, error: string) {
  await prisma.run.update({
    where: { id: runId },
    data: { status: "failed", finishedAt: new Date(), error },
  });
  emitRunEvent(runId, { kind: "run-status", runId, status: "failed" });
}

export async function approveTask(taskId: string) {
  const task = await prisma.task.update({
    where: { id: taskId },
    data: { status: "queued" },
  });
  emitRunEvent(task.runId, { kind: "task-status", taskId: task.id, status: "queued", stepOrder: task.stepOrder });
  return task;
}

export async function rejectTask(taskId: string, reason: string) {
  const task = await prisma.task.update({
    where: { id: taskId },
    data: { status: "failed", error: reason, finishedAt: new Date() },
  });
  await failRun(task.runId, `step ${task.stepOrder} rejected: ${reason}`);
  return task;
}
