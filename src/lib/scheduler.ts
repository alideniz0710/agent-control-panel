import cron, { type ScheduledTask } from "node-cron";
import { prisma } from "./prisma";
import { startRun } from "./workflow";

const jobs = new Map<string, ScheduledTask>();

export async function reloadSchedules() {
  for (const task of jobs.values()) task.stop();
  jobs.clear();

  const workflows = await prisma.workflow.findMany({
    where: { enabled: true, schedule: { not: null } },
  });

  for (const w of workflows) {
    if (!w.schedule) continue;
    if (!cron.validate(w.schedule)) {
      console.warn(`[scheduler] invalid cron "${w.schedule}" on workflow ${w.id}`);
      continue;
    }
    const job = cron.schedule(w.schedule, () => {
      startRun(w.id, "scheduled").catch((e) =>
        console.error(`[scheduler] run failed for workflow ${w.id}`, e),
      );
    });
    jobs.set(w.id, job);
  }
  console.log(`[scheduler] loaded ${jobs.size} scheduled workflow(s)`);
}

let started = false;
export async function startScheduler() {
  if (started) return;
  started = true;
  await reloadSchedules();
}
