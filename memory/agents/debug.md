# cc:debug memory

## Diagnostic approach

Founder is non-dev. Reply with:
1. **Root cause in 1-2 sentences** (plain Turkish)
2. **Why it happened** (1 paragraph max)
3. **Fix proposal** (which files, which lines, what change)
4. Don't open a PR unless asked — describe the fix first, get confirmation

Founder might say `uygula` → then you write the PR.

## Common error sources

### Splitbill — HTTP 500 on POST endpoints
Usually Supabase rejecting. Check:
- `NEXT_PUBLIC_SUPABASE_URL` set on Vercel?
- `SUPABASE_SERVICE_ROLE_KEY` set on Vercel?
- `NEXT_PUBLIC_RESTAURANT_ID` points at a real `restaurants.id` UUID?
- Migrations run on prod DB? (Check `supabase/migrations/` in repo vs Supabase schema)

Postgres error codes:
- `23503` → foreign key violation (most often: restaurant_id doesn't exist)
- `42P01` → table doesn't exist (migrations not run)
- `42501` → insufficient privilege (wrong key / RLS mismatch)
- `23505` → unique constraint (duplicate row)

### Splitbill — bill page shows blank or "Session ended"
Usually JWT expired or session closed. Check:
- `JWT_SECRET` env var set
- `table_sessions.status` for the relevant session
- DB trigger that expires JWTs when session closes

### Panel — agent task fails silently
Look at PM2 logs first: `pm2 logs agent-control-panel --lines 100 --nostream`
- Anthropic 429 → cap exceeded OR rate limit. `/cap status`, `/cap set 12`
- Anthropic 401 → key invalid. Rotate.
- "model not found" → using deprecated model name. Check `src/lib/claudeCodeAgents.ts` for current.

### Panel — webhook receiver not firing
- `tailscale funnel status` on Mac — is Funnel up?
- Curl test: `curl https://alidenizs-mac-mini.tail82cdd7.ts.net/api/hooks/github` should return `{"ok":true,...}`
- Provider-side webhook config: correct URL, correct secret, events selected
- `pm2 logs` for `[hooks/<provider>] signature mismatch` lines

## When to escalate to founder

- Any change to `.env`, `migrations/`, `auth.ts`, `payment/`
- Any "DROP TABLE", "TRUNCATE", or `git push --force`
- Any decision between two approaches with unclear tradeoff
- Cost > $1 estimated for the diagnostic

## Tools for analysis

- Vercel function logs (Founder accesses via vercel.com → project → deployments → function logs)
- Supabase SQL editor (founder needs to copy/paste the query)
- Panel `/health` endpoint for liveness signals
- GitHub PR diffs to verify what changed

## Response style

Same as software-engineer: max 5 Turkish lines for the main answer. Detail only on follow-up question.
