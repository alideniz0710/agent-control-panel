import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const runs = await prisma.run.findMany({
    orderBy: { startedAt: "desc" },
    take: 100,
    include: {
      workflow: { select: { id: true, name: true } },
      tasks: { orderBy: { stepOrder: "asc" }, select: { id: true, status: true, stepOrder: true } },
    },
  });
  return NextResponse.json(runs);
}
