export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startWorker } = await import("./lib/worker");
  const { startScheduler } = await import("./lib/scheduler");
  startWorker();
  await startScheduler();
}
