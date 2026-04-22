// External HTTP trigger for workflows.
//
// POST /api/webhook
//   Authorization: Bearer <WEBHOOK_SECRET>
//   Content-Type: application/json
//   Body: { workflow: "<workflow-name-or-id>", input?: "<override first-step input>" }
//
// Returns 201 { ok: true, runId, workflowName }.
//
// Auth: a single shared secret in the WEBHOOK_SECRET env var. If the env
// var is absent, the endpoint refuses all calls (503) — this is the
// safe default, since an unconfigured webhook should never run workflows.
//
// Look-up: tries the `workflow` field as an id first, falls back to a
// name match. Names aren't schema-unique, so the first match wins.
//
// Input: if body.input is present, it replaces the first step's
// inputTemplate entirely (passed through startRun's firstInput, no race
// against the worker). If omitted, the step's template is used as-is.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { startRun } from "@/lib/workflow";

const Body = z.object({
  workflow: z.string().min(1),
  input: z.string().optional(),
});

function extractToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return auth.trim();
}

export async function POST(req: NextRequest) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "webhook not configured: set WEBHOOK_SECRET in .env" },
      { status: 503 },
    );
  }

  const token = extractToken(req);
  if (!token || token !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const identifier = parsed.data.workflow;
  let workflow = await prisma.workflow.findUnique({ where: { id: identifier } });
  if (!workflow) {
    workflow = await prisma.workflow.findFirst({ where: { name: identifier } });
  }
  if (!workflow) {
    return NextResponse.json({ error: `workflow not found: ${identifier}` }, { status: 404 });
  }
  if (!workflow.enabled) {
    return NextResponse.json(
      { error: `workflow '${workflow.name}' is disabled` },
      { status: 409 },
    );
  }

  try {
    const runId = await startRun(workflow.id, "webhook", parsed.data.input);
    return NextResponse.json(
      { ok: true, runId, workflowName: workflow.name },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to start run";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// Simple health/config check — does NOT leak the secret.
export async function GET() {
  const configured = Boolean(process.env.WEBHOOK_SECRET);
  return NextResponse.json({ configured });
}
