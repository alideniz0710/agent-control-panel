import { NextResponse } from "next/server";
import { BACKENDS } from "@/lib/executor";
import { AVAILABLE_MODELS } from "@/lib/pricing";

export async function GET() {
  return NextResponse.json({
    backends: BACKENDS,
    models: AVAILABLE_MODELS,
  });
}
