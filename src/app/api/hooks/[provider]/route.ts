// Dynamic webhook receiver: /api/hooks/<provider>
//
// Three providers supported: github, vercel, sentry. Each has its own
// signature scheme and event shape; we centralize HMAC verification
// here and delegate semantic parsing to lib/hook-handlers/<provider>.ts.
//
// Why this path is exposed publicly:
//   - middleware.ts whitelists /api/hooks/*
//   - HMAC signatures provide auth: unsigned/forged requests get 401
//   - Path filtering means anything else on the panel stays private
//
// Required env vars (one per provider):
//   GITHUB_WEBHOOK_SECRET    — created when you add the webhook on GitHub
//   VERCEL_WEBHOOK_SECRET    — Vercel integration "Client Secret"
//   SENTRY_WEBHOOK_SECRET    — Sentry integration "Client Secret"
//
// If a secret is not set, requests for that provider are rejected
// (500) with a hint that it's unconfigured. We DON'T fall through to
// "accept unsigned" — that would defeat the security model.
//
// Telegram dispatch: the summarized event text is sent to the chat
// ID in TELEGRAM_CHAT_ID using TELEGRAM_BOT_TOKEN. Failure to send
// is logged but doesn't fail the webhook (Sentry/GitHub retry policy
// is more harmful than a missed message).

import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { summarizeGithub } from "@/lib/hook-handlers/github";
import { summarizeVercel } from "@/lib/hook-handlers/vercel";
import { summarizeSentry } from "@/lib/hook-handlers/sentry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // node crypto needed

type Provider = "github" | "vercel" | "sentry";

function isProvider(s: string): s is Provider {
  return s === "github" || s === "vercel" || s === "sentry";
}

function hexEqual(a: string, b: string): boolean {
  // Constant-time compare to defeat timing attacks
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function verifyGithub(body: string, secret: string, signature: string | null): boolean {
  if (!signature) return false;
  // GitHub sends "sha256=<hex>"
  if (!signature.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return hexEqual(expected, signature.slice(7));
}

function verifyVercel(body: string, secret: string, signature: string | null): boolean {
  if (!signature) return false;
  // Vercel docs: SHA1 HMAC of the raw body, in hex, no prefix
  const expected = createHmac("sha1", secret).update(body).digest("hex");
  return hexEqual(expected, signature);
}

function verifySentry(body: string, secret: string, signature: string | null): boolean {
  if (!signature) return false;
  // Sentry uses SHA256, hex, no prefix
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return hexEqual(expected, signature);
}

async function notifyTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("[hooks] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping notify");
    return;
  }
  // 4096 char cap
  const trimmed = text.length > 4096 ? text.slice(0, 4093) + "..." : text;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: trimmed, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.error("[hooks] telegram notify failed:", e instanceof Error ? e.message : e);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await params;
  if (!isProvider(provider)) {
    return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  }

  // Read raw body for HMAC. Reading it twice would consume the stream
  // so we capture once and re-parse.
  const rawBody = await req.text();

  // Provider-specific verification + summarization
  let summary: string | null = null;
  try {
    if (provider === "github") {
      const secret = process.env.GITHUB_WEBHOOK_SECRET;
      if (!secret) {
        console.error("[hooks/github] GITHUB_WEBHOOK_SECRET not set");
        return NextResponse.json({ error: "provider unconfigured" }, { status: 500 });
      }
      const sig = req.headers.get("x-hub-signature-256");
      if (!verifyGithub(rawBody, secret, sig)) {
        console.warn("[hooks/github] signature mismatch");
        return NextResponse.json({ error: "invalid signature" }, { status: 401 });
      }
      const event = req.headers.get("x-github-event") ?? "unknown";
      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      summary = summarizeGithub({ event, payload });
    } else if (provider === "vercel") {
      const secret = process.env.VERCEL_WEBHOOK_SECRET;
      if (!secret) {
        console.error("[hooks/vercel] VERCEL_WEBHOOK_SECRET not set");
        return NextResponse.json({ error: "provider unconfigured" }, { status: 500 });
      }
      const sig = req.headers.get("x-vercel-signature");
      if (!verifyVercel(rawBody, secret, sig)) {
        console.warn("[hooks/vercel] signature mismatch");
        return NextResponse.json({ error: "invalid signature" }, { status: 401 });
      }
      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      const type = (payload.type as string | undefined) ?? "unknown";
      summary = summarizeVercel({ type, payload });
    } else {
      // sentry
      const secret = process.env.SENTRY_WEBHOOK_SECRET;
      if (!secret) {
        console.error("[hooks/sentry] SENTRY_WEBHOOK_SECRET not set");
        return NextResponse.json({ error: "provider unconfigured" }, { status: 500 });
      }
      const sig = req.headers.get("sentry-hook-signature");
      if (!verifySentry(rawBody, secret, sig)) {
        console.warn("[hooks/sentry] signature mismatch");
        return NextResponse.json({ error: "invalid signature" }, { status: 401 });
      }
      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      const resource = req.headers.get("sentry-hook-resource") ?? "unknown";
      const action = req.headers.get("sentry-hook-type") ?? undefined;
      summary = summarizeSentry({ resource, action, payload });
    }
  } catch (e) {
    console.error(`[hooks/${provider}] handler error:`, e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "handler error" }, { status: 500 });
  }

  // 200 even if we skipped notification (the event was just one we don't
  // care about); we don't want providers to retry.
  if (summary) {
    await notifyTelegram(summary);
  }
  return NextResponse.json({ ok: true, dispatched: summary !== null });
}

// Also accept HEAD/GET for provider ping/test pages (e.g. Vercel sends
// a test request to verify the endpoint exists before saving the hook).
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, message: "webhook receiver ready" });
}
