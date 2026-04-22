// One-shot bulk migration: switch all claude-code-agent backends to
// openrouter-code-agent. Used when the env only has OPENROUTER_API_KEY
// (not ANTHROPIC_API_KEY) so imported Claude Code agents can actually
// run without re-importing them one by one.
//
// Safe to re-run: idempotent. Already-migrated agents are skipped.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(_req: NextRequest) {
  const toMigrate = await prisma.agent.findMany({
    where: { backend: "claude-code-agent" },
    select: { id: true, name: true },
  });

  if (toMigrate.length === 0) {
    return NextResponse.json({ migrated: [], skipped: 0, message: "no claude-code-agent rows to migrate" });
  }

  const result = await prisma.agent.updateMany({
    where: { backend: "claude-code-agent" },
    data: { backend: "openrouter-code-agent" },
  });

  return NextResponse.json({
    migrated: toMigrate.map((a) => a.name),
    count: result.count,
  });
}

// Optional: GET returns dry-run preview (who would be migrated)
export async function GET() {
  const preview = await prisma.agent.findMany({
    where: { backend: "claude-code-agent" },
    select: { id: true, name: true, model: true },
  });
  return NextResponse.json({ wouldMigrate: preview });
}
