import { NextRequest, NextResponse } from "next/server";
import { startRun } from "@/lib/workflow";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const runId = await startRun(id, "manual");
    return NextResponse.json({ runId }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to start run";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
