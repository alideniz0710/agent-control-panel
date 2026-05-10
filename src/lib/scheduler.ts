import cron, { type ScheduledTask } from "node-cron";
import { prisma } from "./prisma";
import { startRun } from "./workflow";

// Why globalThis: Next.js (especially with Turbopack production builds)
// creates separate module instances for the instrumentation hook vs
// route handlers. Module-scoped `started` and `jobs Map` would diverge:
// the route handler's import sees a fresh empty Map even though the
// instrumentation already populated it. Stashing on globalThis ensures
// both contexts see the same instance — same pattern as src/lib/prisma.ts.
type SchedulerGlobal = {
  schedulerStarted?: boolean;
  schedulerJobs?: Map<string, ScheduledTask>;
};
const globalForScheduler = globalThis as unknown as SchedulerGlobal;
const jobs = globalForScheduler.schedulerJobs ?? new Map<string, ScheduledTask>();
globalForScheduler.schedulerJobs = jobs;

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

export async function startScheduler() {
  if (globalForScheduler.schedulerStarted) return;
  globalForScheduler.schedulerStarted = true;
  await reloadSchedules();
}

/** Exposed for /api/health endpoint. */
export function schedulerStatus(): { started: boolean; jobCount: number; timezone: string } {
  return {
    started: Boolean(globalForScheduler.schedulerStarted),
    jobCount: jobs.size,
    timezone: SCHEDULER_TZ,
  };
}
