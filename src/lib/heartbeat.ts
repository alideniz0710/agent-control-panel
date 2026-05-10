// Heartbeat to healthchecks.io (or any equivalent ping URL).
//
// Why: when the founder is in Korea and the panel dies (Mac power loss,
// Wi-Fi drop, process crash that PM2 can't recover, etc.), they need to
// know within ~10 minutes — not hours later when they next check the
// dashboard.
//
// How: every 5 minutes we POST to a configured URL (HEALTHCHECKS_URL
// in env, e.g. https://hc-ping.com/<uuid>). Healthchecks.io expects a
// ping at most every N minutes (configured at hc.io side, recommend 10-15
// min to allow for network blips). If a ping is missed, hc.io sends a
// Telegram alert via its built-in integration.
//
// Why not poll-based monitoring (UptimeRobot etc.) instead?
// - Outbound heartbeat works behind NAT/Tailscale without a public URL.
// - Single source of truth for "panel is alive AND can make HTTPS calls"
//   (covers more failure modes than just "port 3000 listening").
//
// Failure modes:
// - HEALTHCHECKS_URL not set → heartbeat module is a no-op (fine; user
//   chose not to configure monitoring).
// - Single ping fails (network blip) → silent retry next interval.
// - Persistent failure (15+ min) → hc.io fires the user alert.

const PING_INTERVAL_MS = 5 * 60 * 1000; // 5 min

type HeartbeatGlobal = { heartbeatStarted?: boolean; heartbeatLastPingAt?: number };
const globalForHeartbeat = globalThis as unknown as HeartbeatGlobal;

async function ping(url: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (!res.ok) {
      console.warn(`[heartbeat] ping returned ${res.status}`);
      return;
    }
    globalForHeartbeat.heartbeatLastPingAt = Date.now();
  } catch (e) {
    console.warn("[heartbeat] ping failed:", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

export function startHeartbeat(): void {
  if (globalForHeartbeat.heartbeatStarted) return;
  const url = process.env.HEALTHCHECKS_URL;
  if (!url) {
    console.log("[heartbeat] HEALTHCHECKS_URL not set — skipping (no external monitoring)");
    return;
  }
  globalForHeartbeat.heartbeatStarted = true;
  console.log(`[heartbeat] started — pinging ${url.replace(/\/[^/]+$/, "/<id>")} every ${PING_INTERVAL_MS / 1000}s`);
  // First ping immediately (so external monitor sees us alive on boot)
  void ping(url);
  setInterval(() => void ping(url), PING_INTERVAL_MS);
}

/** Exposed for /api/health endpoint. */
export function heartbeatStatus(): { started: boolean; lastPingAt: string | null; configured: boolean } {
  return {
    started: Boolean(globalForHeartbeat.heartbeatStarted),
    lastPingAt: globalForHeartbeat.heartbeatLastPingAt
      ? new Date(globalForHeartbeat.heartbeatLastPingAt).toISOString()
      : null,
    configured: Boolean(process.env.HEALTHCHECKS_URL),
  };
}
