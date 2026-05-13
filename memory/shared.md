# Project Context (all agents)

## Identity

Founder is **Ali Deniz Aslan** (Türkiye, 2026-05). **Not a developer** — cannot read code, communicates in Turkish, uses panel via Telegram from phone.

GitHub: `alideniz0710`. Two active repos:
- `alideniz0710/agent-control-panel` — this panel itself (Next.js 16 + Prisma + SQLite, runs on Mac Mini at home)
- `alideniz0710/splitbill` — restaurant bill-split web app (Next.js 14 App Router + Supabase, deployed on Vercel)

## Active deployments

| What | Where | URL |
|---|---|---|
| Panel | Mac Mini, PM2 | Tailscale-only `alidenizs-mac-mini.tail82cdd7.ts.net:3000` |
| Splitbill prod (main) | Vercel | `https://splitbill-chi-gilt.vercel.app` |
| Public webhook receiver | Tailscale Funnel | `https://alidenizs-mac-mini.tail82cdd7.ts.net/api/hooks/{github,vercel,sentry}` |

## Critical env vars (Splitbill)

If any of these are missing, `/admin/tables`-style pages crash:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_RESTAURANT_ID` (UUID of an actual row in `restaurants` table)
- `JWT_SECRET`
- `NEXT_PUBLIC_APP_URL` (`https://splitbill-chi-gilt.vercel.app`)

## Splitbill product summary

- Customer scans QR on table → opens `/bill/<token>` → sees bill → pays share
- Payment modes: `item_based`, `equal_split`, `custom_amount`, `full_remaining`
- Waiter view at `/waiter`, Admin at `/admin/tables`
- Tech: App Router (NOT Pages Router), Supabase + Realtime + RLS, custom JWT auth
- See SPEC.md in repo for product rules. NEVER hardcode "Iyzico" or "PayTR" — go through `lib/payment/`

## Splitbill MVP progress (as of 2026-05-14)

Done:
- Bill page (equal split mode)
- Admin table management with QR codes
- Waiter dashboard
- Sprint 2.2 backend (item selection endpoints + ItemSelection table)
- Sprint 2.3 spec drafted (custom amount)

Pending:
- Sprint 2.2 frontend (item selection UI on bill page) — MUST for demo
- Sprint 2.3 implement (custom amount mode UI + backend)
- Sprint 3.1 soloist lock UI (banner when someone is in selection mode)
- Sentry SDK installation
- Iyzico/PayTR payment integration

## Panel ops cheat sheet

Telegram commands:
- `/se <task>` — direct to cc:software-engineer
- `/debug <symptom>` — direct to cc:debug
- `/pa <task>` — direct to cc:personal-assistant
- Plain text → orchestrator-router → routes automatically
- Voice / photo → transcribed/analyzed → orchestrator path
- `/memo <text>` — append to this shared memory
- `/memo <agent> <text>` — append to a specific agent's memory
- `/undo`, `/revert <PR-no>`, `/kill`, `/sync`, `/backup status`, `/cap status`, `/auto on|off`

## Auto-merge gate (panel only — splitbill repo has no gate)

For a PR on agent-control-panel to auto-merge, ALL of these must hold:
- `/auto` is on (`auto.enabled = "on"`)
- PR title starts with `[XS]` or `[S]` (size tag)
- Not a draft
- All CI checks green (build step is the hard gate; type-check/lint/test are continue-on-error)
- No files match deny-list: `.env`, `package.json`, `*.config.*`, `next.config.*`, `vercel.json`, `middleware.ts`, `migrations/`, `auth/`, `api/webhook/`
- At least one test file changed OR title has `[no-test]` token

When in doubt: add `[S] ... [no-test]` to title. Even for code-only changes without tests.

## Recent learnings (last 30 days)

### 2026-05-14 — Splitbill masa-ekleme HTTP 500
Bug was NOT cache (earlier PR thought so). Real cause: `NEXT_PUBLIC_RESTAURANT_ID` env var was missing on Vercel. Frontend sent `restaurant_id: undefined`, backend returned 400, frontend showed generic "Masa eklenemedi" with no specifics. Fixed by:
1. Surfacing the actual HTTP error code + body in the toast
2. Detecting missing RESTAURANT_ID client-side and showing a clear "set this env var on Vercel" message
3. Dynamic QR base URL (was hardcoded to `192.168.1.112:3001`)

**Takeaway:** When a page does `process.env.X!`, also detect undefined and show a diagnostic. Don't silently fail. Same for backend — return Supabase error code/message, not just generic 500.

### 2026-05-13 — Vision feature shipped with wrong model name
Agent wrote `claude-3-5-sonnet-20241022` in `vision.ts`. That model is retired. Codebase convention is `claude-sonnet-4-6`. Result: 404 on every photo dispatch.

**Takeaway:** When picking a Claude model, grep the repo first for what other files use. Don't pull from training data — model names rotate.

### 2026-05-13 — CI failures from cross-platform lockfile
`npm ci` failed in CI because `package-lock.json` was generated on Mac M-series and only had `darwin-arm64` entries for native-binary packages (sharp, next/swc, claude-agent-sdk). Ubuntu CI needs `linux-x64` entries which weren't there.

**Fix:** Use `npm install --no-audit --prefer-offline --no-fund` instead of `npm ci` in CI workflows. Also set `DATABASE_URL=file:./prisma/ci.db` and run `prisma db push` before build so prerendered routes that touch Prisma don't crash.

### 2026-05-12 — B2 backup v3 API shape
Backblaze B2 `b2_authorize_account` v3 returns `apiInfo.storageApi.{apiUrl, bucketId, bucketName}` — NOT v2's `apiUrl` + `allowed.bucketId`. Mixing the two shapes silently broke backup uploads.

**Takeaway:** When using a new API, copy the exact response example from current docs into the type definition.


<!-- auto-write entries below -->
