# cc:software-engineer memory

## Project conventions

### Splitbill (App Router)

- `app/` directory with `page.tsx` + `route.ts` files
- Routes that matter:
  - `app/bill/[token]/page.tsx` — customer bill page (CRITICAL)
  - `app/admin/tables/page.tsx` — admin QR/table management
  - `app/waiter/page.tsx` — waiter dashboard
  - `app/api/admin/tables/route.ts` — POST/GET tables
  - `app/api/bill/[token]/select-mode/route.ts` — item selection (Sprint 2.2)
- Supabase clients in `lib/supabase.ts`:
  - `supabaseAdmin` (service role) — server only, bypasses RLS
  - `supabaseAnon` (public anon) — for realtime subscriptions client-side
- `lib/auth.ts` — JWT create/verify (NEVER break — all customer auth depends on it)
- `lib/payment/provider.ts` — abstraction interface; NEVER hardcode iyzico or paytr names

### agent-control-panel (Next.js 16, this repo)

- App Router under `src/app/`
- Prisma with SQLite at `prisma/dev.db`, WAL mode
- All env vars must be in `.env` (Mac) — never commit `.env`
- Telegram poller in `src/lib/telegram-poller.ts`
- Worker (executes tasks) in `src/lib/worker.ts`
- Dispatcher (orchestrator JSON → run) in `src/lib/executor/dispatcher.ts`
- Models registry in `src/lib/claudeCodeAgents.ts` — use the model names there, NOT old `claude-3-5-sonnet-*`

## PR rules (auto-merge gate)

**Always** include these in PR title for splitbill OR panel:

- `[S]` size tag (or `[XS]` for tiny diffs, `[M]`/`[L]` for bigger — but M+ won't auto-merge)
- `[no-test]` token if no test file added
- Example: `[S] fix: cache opt-out in admin tables [no-test]`

**Always** include in PR description:

```
## Telefon test adımları
1. <Vercel preview URL veya production URL>
2. <ne tıklayacak / ne girecek>
3. <beklenen sonuç>
```

The founder is on phone and tests there. Without these steps they can't verify.

## Files NOT to touch (auto-merge deny-list)

These trigger a manual-review flag even on [S] PRs:
- `.env*`
- `package.json`, `package-lock.json`
- `*.config.{ts,js,mjs,cjs}`
- `next.config.*`, `vercel.json`
- `middleware.ts`, `*/middleware.{ts,js}`
- `migrations/`, `auth/`, `api/webhook/`

If you MUST touch one, fine — but tell the founder in PR description: "manual review needed because <file> is in deny-list".

## Response style

The founder isn't a developer. Reply to a /se task with:

- Max **5 lines** Turkish summary
- Don't paste code blocks unless asked
- One PR link + one-line test instruction
- Mention which files changed in passing — not full diff

If a task NEEDS more explanation (architectural choice with tradeoffs), ask the founder which option they prefer in 2-3 lines, don't pick alone.

## Common pitfalls

- **Splitbill uses App Router.** Don't assume Pages Router. `app/foo/page.tsx`, NOT `pages/foo.tsx`.
- **Process env vars need quoting in code:** `process.env.X ?? ''` defensive default beats `process.env.X!` non-null assertion in client components — the latter silently passes `undefined` strings to APIs.
- **QR codes need a public origin.** Don't hardcode IPs; use `window.location.origin` client-side OR a `NEXT_PUBLIC_BASE_URL` / `NEXT_PUBLIC_APP_URL` env var.
- **Vercel needs ALL `NEXT_PUBLIC_*` env vars to be set per environment** (Production / Preview / Development). Mark sensitive ones as "Sensitive" but those won't apply to Development — that's fine, founder doesn't use local dev.
- **Migrations are NEVER run by agents.** If schema change needed, write the migration file but tell founder to run it manually (or describe the SQL).

## Recent file additions

- 2026-05-13: `app/api/bill/[token]/select-mode/route.ts` + Prisma ItemSelection table (Sprint 2.2 backend, frontend pending)
- 2026-05-13: `lib/supabase.ts` is single source for both clients; old `lib/supabase-anon.ts` consolidated


<!-- auto-write entries below -->
