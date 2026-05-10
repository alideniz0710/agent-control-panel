// Liveness + status endpoint.
//
// GET /api/health
//   200 OK { ok: true, ... }
//
// Designed for two consumers:
//   1. External uptime monitoring (healthchecks.io, UptimeRobot, etc.) —
//      checks 200 vs non-200 to know if panel is up
//   2. The founder, manually from a browser when bot doesn't reply, to
//      diagnose whether panel is alive but bot is broken (returns ok)
//      vs panel is dead (no response or 500)
//
// NOT auth-gated. The middleware excludes this path so external pingers
// can hit it without ADMIN_TOKEN. Output contains no secrets — only
// counts, timestamps, and config flags.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { pollerStatus } from "@/lib/telegram-poller";
import { schedulerStatus } from "@/lib/scheduler";
import { workerStatus } from "@/lib/worker";
import { heartbeatStatus } from "@/lib/heartbeat";
import { capStatus } from "@/lib/cost-cap";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = process.uptime();

  let lastTaskAt: string | null = null;
  let runsLast24h = 0;
  let cap: Awaited<ReturnType<typeof capStatus>> | null = null;
  try {
    const lastTask = await prisma.task.findFirst({
      where: { startedAt: { not: null } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    });
    lastTaskAt = lastTask?.startedAt?.toISOString() ?? null;

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    runsLast24h = await prisma.run.count({ where: { startedAt: { gte: since } } });

    cap = await capStatus();
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "db_error",
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }

  const sched = schedulerStatus();
  const poller = pollerStatus();
  const worker = workerStatus();
  const hb = heartbeatStatus();

  return NextResponse.json({
    ok: true,
    uptimeSeconds: Math.round(startedAt),
    nodeVersion: process.version,
    nowIso: new Date().toISOString(),
    worker,
    scheduler: sched,
    telegramPoller: {
      started: poller.started,
      lastUpdateId: poller.lastUpdateId,
      processedCount: poller.processedCount,
      tokenConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      chatIdConfigured: Boolean(process.env.TELEGRAM_CHAT_ID),
    },
    heartbeat: hb,
    runs: { last24h: runsLast24h, lastTaskAt },
    cap,
    flags: {
      anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      openrouterKeyConfigured: Boolean(process.env.OPENROUTER_API_KEY),
      webhookSecretConfigured: Boolean(process.env.WEBHOOK_SECRET),
    },
  });
}
