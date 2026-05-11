export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startWorker } = await import("./lib/worker");
  const { startScheduler } = await import("./lib/scheduler");
  const { startTelegramPoller } = await import("./lib/telegram-poller");
  const { startHeartbeat } = await import("./lib/heartbeat");
  const { startAutoMerge } = await import("./lib/auto-merge");
  const { startBackupSchedule } = await import("./lib/backup");
  startWorker();
  await startScheduler();
  startTelegramPoller();
  startHeartbeat();
  startAutoMerge();
  startBackupSchedule();
}
