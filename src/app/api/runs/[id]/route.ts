import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const run = await prisma.run.findUnique({
    where: { id },
    include: {
      workflow: true,
      tasks: {
        orderBy: { stepOrder: "asc" },
        include: {
          agent: true,
          logs: { orderBy: { at: "asc" } },
        },
      },
    },
  });
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(run);
}
