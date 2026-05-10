// Daily cost cap.
//
// Why: an agent (especially a tool-using SDK one) can chew through
// dollars fast if it gets stuck in a loop, encounters a misformatted
// task, or just decides to do something expensive. While the founder
// is in Korea with patchy internet, "spent $200 overnight on garbage
// runs" is a real risk. This module caps daily LLM spend.
//
// Mechanism:
//   - Cap stored in Setting table, key="cap.dailyUsd", value="<float>"
//   - Default = 5.00 USD (override by setting the row, or by /cap set)
//   - Worker calls assertUnderCap() before claiming a queued task;
//     if rolling 24h spend > cap, throws and worker skips
//   - Skipped task gets a "skipped" state with the cap-hit reason
//     so the user can see it in the UI / dashboard and know why
//     things stopped
//
// Cost source: local Task.cost column (computed at task done time
// from token counts × pricing table). NOT the Anthropic billing API
// — that has ~1h delay and we want this check to run instantly.

import { prisma } from "./prisma";

const CAP_KEY = "cap.dailyUsd";
const DEFAULT_CAP_USD = 5.0;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

export class CostCapExceededError extends Error {
  spentUsd: number;
  capUsd: number;
  constructor(spentUsd: number, capUsd: number) {
    super(
      `daily cost cap exceeded: spent $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)} in last 24h`,
    );
    this.name = "CostCapExceededError";
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
  }
}

/** Returns the active cap in USD. Reads from Setting table; falls back to default. */
export async function getCap(): Promise<number> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: CAP_KEY } });
    if (!row) return DEFAULT_CAP_USD;
    const n = parseFloat(row.value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_CAP_USD;
    return n;
  } catch {
    return DEFAULT_CAP_USD;
  }
}

/** Updates the cap. Caller (e.g., /cap set command) is responsible for validation. */
export async function setCap(usd: number): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error(`invalid cap: ${usd} (must be positive number)`);
  }
  await prisma.setting.upsert({
    where: { key: CAP_KEY },
    create: { key: CAP_KEY, value: String(usd) },
    update: { value: String(usd) },
  });
}

/** Sum of Task.cost for tasks finished or started in the last 24h. */
export async function rollingSpend(): Promise<number> {
  const since = new Date(Date.now() - ROLLING_WINDOW_MS);
  const result = await prisma.task.aggregate({
    where: {
      OR: [
        { startedAt: { gte: since } },
        { finishedAt: { gte: since } },
      ],
    },
    _sum: { cost: true },
  });
  return result._sum.cost ?? 0;
}

/** Throws CostCapExceededError if rolling spend > cap. Cheap to call (one aggregate query). */
export async function assertUnderCap(): Promise<{ spentUsd: number; capUsd: number }> {
  const [spent, cap] = await Promise.all([rollingSpend(), getCap()]);
  if (spent > cap) {
    throw new CostCapExceededError(spent, cap);
  }
  return { spentUsd: spent, capUsd: cap };
}

/** Status report for /cap status and /api/health. */
export async function capStatus(): Promise<{
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
  isOverCap: boolean;
}> {
  const [spent, cap] = await Promise.all([rollingSpend(), getCap()]);
  return {
    capUsd: cap,
    spentUsd: spent,
    remainingUsd: Math.max(0, cap - spent),
    isOverCap: spent > cap,
  };
}
