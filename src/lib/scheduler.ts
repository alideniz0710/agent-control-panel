import cron, { type ScheduledTask } from "node-cron";
import { prisma } from "./prisma";
import { startRun } from "./workflow";

const jobs = new Map<string, ScheduledTask>();

// Pin cron interpretation to a fixed timezone so scheduled workflows
// (e.g., 08:00 morning brief) fire at the same wall-clock time regardless
// of where the host machine's clock is set OR where the founder is
// physically located. Default = Europe/Istanbul (founder's home TZ);
// override via SCHEDULER_TZ env if needed.
const SCHEDULER_TZ = process.env.SCHEDULER_TZ || "Europe/Istanbul";

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
    const job = cron.schedule(
      w.schedule,
      () => {
        startRun(w.id, "scheduled").catch((e) =>
          console.error(`[scheduler] run failed for workflow ${w.id}`, e),
        );
      },
      { timezone: SCHEDULER_TZ },
    );
    jobs.set(w.id, job);
  }
  console.log(
    `[scheduler] loaded ${jobs.size} scheduled workflow(s) (timezone: ${SCHEDULER_TZ})`,
  );
}

let started = false;
export async function startScheduler() {
  if (started) return;
  started = true;
  await reloadSchedules();
}

/** Exposed for /api/health endpoint. */
export function schedulerStatus(): { started: boolean; jobCount: number; timezone: string } {
  return { started, jobCount: jobs.size, timezone: SCHEDULER_TZ };
}
