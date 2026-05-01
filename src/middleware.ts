// Public-access gatekeeper.
//
// Goal: keep the panel safe when exposed via Tailscale Funnel (or any
// other public tunnel). The webhook endpoint has its own Bearer-token
// auth (WEBHOOK_SECRET); the rest of the panel — UI pages and admin
// API routes — must NOT be reachable by anonymous internet visitors.
//
// Allowed (no token needed):
//   - /api/webhook            handles its own auth
//   - direct localhost calls  Host header starts with localhost or 127.
//   - tailnet members         Tailscale daemon adds Tailscale-User-Login
//
// Allowed via shared secret:
//   - any path with header     Authorization: Bearer <ADMIN_TOKEN>
//
// Everything else gets a 401.
//
// If ADMIN_TOKEN is not set in the environment, the only way in for a
// public visitor is via /api/webhook — i.e. the panel is "tailnet-only
// + webhook" by default, no extra config needed. Set ADMIN_TOKEN to
// give yourself a way to admin the panel from a non-tailnet machine.

import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PATH_PREFIXES = ["/api/webhook"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

function isLocalhostRequest(host: string | null): boolean {
  if (!host) return false;
  // Matches "localhost", "localhost:3000", "127.0.0.1:3000", "[::1]:3000"
  return (
    host.startsWith("localhost") ||
    host.startsWith("127.") ||
    host.startsWith("[::1]")
  );
}

function isTailnetRequest(req: NextRequest): boolean {
  // Tailscale daemon stamps these on requests it forwards from tailnet
  // members (NOT on Funnel public requests). Presence of any one is a
  // strong signal the caller is authenticated to your tailnet.
  return (
    req.headers.get("tailscale-user-login") !== null ||
    req.headers.get("tailscale-user-name") !== null ||
    req.headers.get("tailscale-user-profile-pic") !== null
  );
}

function hasValidAdminToken(req: NextRequest): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : auth.trim();
  return token === expected;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublicPath(pathname)) return NextResponse.next();

  const host = req.headers.get("host");
  if (isLocalhostRequest(host)) return NextResponse.next();

  if (isTailnetRequest(req)) return NextResponse.next();

  if (hasValidAdminToken(req)) return NextResponse.next();

  // Block. JSON for API routes, plain text otherwise.
  const isApi = pathname.startsWith("/api/");
  if (isApi) {
    return new NextResponse(
      JSON.stringify({ error: "unauthorized" }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    );
  }
  return new NextResponse("Unauthorized\n", {
    status: 401,
    headers: { "content-type": "text/plain" },
  });
}

// Run on every route except Next.js internals + static files. Static
// asset requests are noisy and don't expose anything sensitive on
// their own (the HTML they belong to IS protected).
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp)$).*)",
  ],
};
