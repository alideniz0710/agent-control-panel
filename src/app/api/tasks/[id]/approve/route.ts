import { NextRequest, NextResponse } from "next/server";
import { approveTask } from "@/lib/workflow";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const task = await approveTask(id);
    return NextResponse.json(task);
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
