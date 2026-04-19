# Agent Control Panel

A personal, self-hosted orchestrator for AI agents. See your agents, order them into
workflows, watch them live, schedule them, approve sensitive steps, and track cost —
all in a single Next.js process. Designed to run 24/7 on a Mac Mini or similar.

## Features

- **Agent registry** — reusable agent definitions with backend, model, system prompt.
- **Workflows** — ordered steps where each step's output feeds the next via `{{previousOutput}}`.
- **Live logs** — real-time streaming of each step's output via SSE.
- **Scheduling** — cron expressions per workflow, evaluated by `node-cron` in-process.
- **Approval gates** — mark a step as requiring manual approval before it runs.
- **Cost tracking** — per-task token + USD cost, rolled up to runs and a daily dashboard.
- **Three backends**:
  - `claude-agent-sdk` — full Claude Code agent with tools/file access (`@anthropic-ai/claude-agent-sdk`).
  - `anthropic-api` — single-shot text via `@anthropic-ai/sdk`.
  - `fake` — no network; useful for dev.
- **Claude Code integration** — import or live-reference custom agents from `~/.claude/agents/`.

## Stack

- Next.js 16 (App Router) — UI + API routes
- Prisma 6 + SQLite — persistence (single `dev.db` file)
- `node-cron` — scheduler
- In-memory `EventEmitter` — pushes live events to SSE
- Tailwind CSS — styling

Everything runs in one Node process, so there is no Redis, no separate worker, no broker.

## Local setup

```bash
npm install
cp .env.example .env
# edit .env and set ANTHROPIC_API_KEY
npx prisma migrate dev
npm run dev
```

Open http://localhost:3000.

## Importing your Claude Code agents

1. Have at least one Markdown file in `~/.claude/agents/<name>.md` (or `<project>/.claude/agents/`).
2. Go to **Agents → Import from Claude Code**.
3. Pick **Live reference** (re-reads the file every run — changes flow through automatically)
   or **Clone** (one-time copy you can edit in the panel).
4. Select one or more agents and click **Import**.

Imported agents appear prefixed `cc:<name>` in the agent list.

## Deploying on a Mac Mini (24/7)

The app is a single Node process. Keep it alive with PM2 (or `launchd`):

```bash
# one-time
npm install -g pm2
npm install
npx prisma migrate deploy
npm run build

# run
pm2 start npm --name agent-control-panel -- run start
pm2 save
pm2 startup   # prints a one-liner to enable boot startup
```

The scheduler registers cron jobs in-process on boot (`src/instrumentation.ts`), so scheduled
workflows fire any time the process is running. `recoverInflight()` marks stuck `running`
tasks as failed after a restart so runs don't hang silently.

## Common cron examples

| Expression | Meaning |
|---|---|
| `*/5 * * * *` | every 5 minutes |
| `0 9 * * *` | daily at 9 AM |
| `0 9 * * 1-5` | weekdays at 9 AM |
| `0 0 1 * *` | first of every month |

## Project layout

```
src/
  app/
    api/              # CRUD + run + SSE endpoints
    agents/           # agents list, new, edit, import
    workflows/        # workflow list, builder, detail
    runs/             # run history + live run view
    schedule/         # scheduled workflows
    page.tsx          # dashboard
  lib/
    prisma.ts
    pricing.ts        # $/MTok table
    events.ts         # in-memory event bus
    executor/
      types.ts        # Executor interface
      fake.ts
      anthropicApi.ts
      claudeAgentSdk.ts
      claudeCodeAgent.ts   # live-reference backend
      index.ts
    claudeCodeAgents.ts    # reads ~/.claude/agents/*.md
    workflow.ts       # startRun / advanceAfterTask / approve / reject
    worker.ts         # polling worker
    scheduler.ts      # node-cron integration
  components/ui.tsx
  instrumentation.ts  # Next.js boot hook — starts worker + scheduler
prisma/schema.prisma
```

## Environment

| Var | Purpose |
|---|---|
| `DATABASE_URL` | SQLite file path (default `file:./dev.db`) |
| `ANTHROPIC_API_KEY` | Required for `claude-agent-sdk` and `anthropic-api` backends |

## Data model

See `prisma/schema.prisma`. The shape is Agent → Workflow → WorkflowStep → Run → Task → LogLine.

## Not included (yet)

- Visual node-graph editor (n8n-style)
- Multi-user auth
- Integrations beyond Anthropic (webhooks, OpenAI, Slack)
- Distributed workers across machines
- Secrets vault (use `.env`)
