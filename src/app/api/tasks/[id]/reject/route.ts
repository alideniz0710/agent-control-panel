import { NextRequest, NextResponse } from "next/server";
import { rejectTask } from "@/lib/workflow";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" ? body.reason : "rejected";
  try {
    const task = await rejectTask(id, reason);
    return NextResponse.json(task);
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
