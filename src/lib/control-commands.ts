// Direct-action Telegram control commands.
//
// These execute INLINE in the polling worker (not via the workflow
// engine), so they respond fast even when the worker is saturated
// with long-running agent tasks. Keep their bodies cheap — no LLM
// calls, no multi-second I/O without good reason.
//
// /ping              liveness check, returns uptime + last task time
// /auto on|off       toggle global auto-merge flag (read by Day 4)
// /cap [status|set <usd>]   inspect / set daily cost cap
// /kill [<task-id>]  abort a running task; with no arg, lists running
// /deploy [status|retry]    Vercel: query last deploys / trigger redeploy
// /revert <pr-number>       help text + revert link for a merged PR
// /agents            list configured panel agents (audit from Korea)

import { prisma } from "./prisma";
import { capStatus, setCap } from "./cost-cap";
import { killTask, listInflightTaskIds } from "./worker";

type SendFn = (chatId: number | string, text: string) => Promise<void>;

const AUTO_KEY = "auto.enabled";

// ── helpers ────────────────────────────────────────────────────────────

function fmtAge(date: Date | null | undefined): string {
  if (!date) return "never";
  const ageMs = Date.now() - date.getTime();
  const min = Math.floor(ageMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtUptime(seconds: number): string {
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

// ── /ping ──────────────────────────────────────────────────────────────

export async function handlePing(chatId: number | string, send: SendFn): Promise<void> {
  const lastTask = await prisma.task.findFirst({
    where: { startedAt: { not: null } },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true, status: true },
  });
  const inflight = listInflightTaskIds();
  await send(
    chatId,
    [
      "pong 🏓",
      `panel up: ${fmtUptime(process.uptime())}`,
      `last task: ${fmtAge(lastTask?.startedAt)} (${lastTask?.status ?? "n/a"})`,
      `inflight: ${inflight.length} task(s)`,
    ].join("\n"),
  );
}

// ── /auto ──────────────────────────────────────────────────────────────

export async function getAutoEnabled(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: AUTO_KEY } });
  return row?.value === "on";
}

export async function handleAuto(chatId: number | string, args: string, send: SendFn): Promise<void> {
  const arg = args.trim().toLowerCase();
  if (arg === "") {
    const current = await getAutoEnabled();
    await send(chatId, `auto-merge: ${current ? "on ✅" : "off"}\n\nUsage: /auto on  |  /auto off`);
    return;
  }
  if (arg !== "on" && arg !== "off") {
    await send(chatId, "Usage: /auto on  |  /auto off");
    return;
  }
  await prisma.setting.upsert({
    where: { key: AUTO_KEY },
    create: { key: AUTO_KEY, value: arg },
    update: { value: arg },
  });
  await send(chatId, `✓ auto-merge ${arg}`);
}

// ── /cap ───────────────────────────────────────────────────────────────

export async function handleCap(chatId: number | string, args: string, send: SendFn): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase() || "status";

  if (sub === "status") {
    const s = await capStatus();
    await send(
      chatId,
      [
        `cap:       $${s.capUsd.toFixed(2)} / day`,
        `spent:     $${s.spentUsd.toFixed(4)} (rolling 24h)`,
        `remaining: $${s.remainingUsd.toFixed(4)}`,
        s.isOverCap ? "⚠️  OVER CAP — worker paused" : "✓  under cap",
      ].join("\n"),
    );
    return;
  }

  if (sub === "set") {
    const usd = parseFloat(parts[1] ?? "");
    if (!Number.isFinite(usd) || usd <= 0) {
      await send(chatId, "Usage: /cap set <usd>\nExample: /cap set 10.00");
      return;
    }
    await setCap(usd);
    await send(chatId, `✓ cap set to $${usd.toFixed(2)} / day`);
    return;
  }

  await send(chatId, "Usage: /cap status  |  /cap set <usd>");
}

// ── /kill ──────────────────────────────────────────────────────────────

export async function handleKill(chatId: number | string, args: string, send: SendFn): Promise<void> {
  const taskId = args.trim();

  if (!taskId) {
    const ids = listInflightTaskIds();
    if (ids.length === 0) {
      await send(chatId, "No tasks currently running.");
      return;
    }
    const tasks = await prisma.task.findMany({
      where: { id: { in: ids } },
      include: { agent: true, run: { include: { workflow: true } } },
    });
    const lines = tasks.map(
      (t) =>
        `${t.id}\n  workflow: ${t.run.workflow.name}\n  agent: ${t.agent.name}\n  input: ${t.input.slice(0, 80)}...`,
    );
    await send(chatId, `Running tasks (${tasks.length}):\n\n${lines.join("\n\n")}\n\nUsage: /kill <task-id>`);
    return;
  }

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) {
    await send(chatId, `Task not found: ${taskId}`);
    return;
  }
  if (task.status !== "running") {
    await send(chatId, `Task is "${task.status}", not running. Nothing to kill.`);
    return;
  }
  const aborted = killTask(taskId);
  if (!aborted) {
    await send(chatId, `Task ${taskId} is marked running but no abort controller registered (worker restart?). Marking failed manually.`);
  }
  await prisma.task.update({
    where: { id: taskId },
    data: { status: "failed", finishedAt: new Date(), error: "killed by /kill command" },
  });
  await send(chatId, `✓ task ${taskId} killed`);
}

// ── /deploy ────────────────────────────────────────────────────────────

interface VercelDeployment {
  uid: string;
  state: string;
  url: string;
  createdAt: number;
  meta?: { githubCommitMessage?: string };
}

export async function handleDeploy(chatId: number | string, args: string, send: SendFn): Promise<void> {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) {
    await send(
      chatId,
      "Vercel API not configured.\n\n" +
        "Add to ~/.zshrc:\n" +
        '  export VERCEL_TOKEN="..."\n' +
        '  export VERCEL_PROJECT_ID="..."\n\n' +
        "Token: vercel.com → Settings → Tokens → Create\n" +
        "Project ID: vercel.com → splitbill project → Settings → General",
    );
    return;
  }

  const sub = args.trim().split(/\s+/)[0]?.toLowerCase() || "status";

  if (sub === "status") {
    try {
      const res = await fetch(
        `https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=3`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        await send(chatId, `Vercel API error: ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
        return;
      }
      const data = (await res.json()) as { deployments?: VercelDeployment[] };
      const deps = data.deployments ?? [];
      if (deps.length === 0) {
        await send(chatId, "No deployments yet.");
        return;
      }
      const stateEmoji = (s: string) =>
        s === "READY" ? "✅" : s === "ERROR" ? "❌" : s === "BUILDING" || s === "QUEUED" ? "⏳" : "·";
      const lines = deps.map((d) => {
        const ts = new Date(d.createdAt).toISOString().slice(0, 16).replace("T", " ");
        const msg = d.meta?.githubCommitMessage?.slice(0, 60) ?? "";
        return `${stateEmoji(d.state)} ${d.state.padEnd(8)} ${ts}\n   ${d.url}\n   ${msg}`;
      });
      await send(chatId, `Last ${deps.length} deploys:\n\n${lines.join("\n\n")}`);
    } catch (e) {
      await send(chatId, `Vercel fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (sub === "retry") {
    try {
      const lastRes = await fetch(
        `https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=1`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const lastData = (await lastRes.json()) as { deployments?: VercelDeployment[] };
      const last = lastData.deployments?.[0];
      if (!last) {
        await send(chatId, "No prior deployment to retry.");
        return;
      }
      const retryRes = await fetch(`https://api.vercel.com/v13/deployments?forceNew=1`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: "splitbill",
          deploymentId: last.uid,
          target: "production",
        }),
      });
      if (!retryRes.ok) {
        const errText = await retryRes.text().then((t) => t.slice(0, 300));
        await send(chatId, `Vercel retry failed: ${retryRes.status}\n${errText}`);
        return;
      }
      const newDep = (await retryRes.json()) as { url?: string };
      await send(chatId, `✓ retry triggered\nhttps://${newDep.url ?? "(check vercel.com)"}`);
    } catch (e) {
      await send(chatId, `Vercel retry failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  await send(chatId, "Usage: /deploy status  |  /deploy retry");
}

// ── /revert ────────────────────────────────────────────────────────────

export async function handleRevert(chatId: number | string, args: string, send: SendFn): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO ?? "alideniz0710/splitbill";
  const prNum = parseInt(args.trim(), 10);

  if (!Number.isFinite(prNum)) {
    await send(chatId, "Usage: /revert <pr-number>\nExample: /revert 42");
    return;
  }

  if (!token) {
    await send(
      chatId,
      "GitHub API not configured.\n\n" +
        "Add to ~/.zshrc:\n" +
        '  export GITHUB_TOKEN="ghp_..."\n\n' +
        "Token: github.com → Settings → Developer settings → Personal access tokens (fine-scoped) → repo write on splitbill + agent-control-panel only",
    );
    return;
  }

  try {
    const prRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNum}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!prRes.ok) {
      await send(chatId, `Couldn't fetch PR #${prNum}: ${prRes.status}`);
      return;
    }
    const pr = (await prRes.json()) as {
      title?: string;
      state?: string;
      merged?: boolean;
      merge_commit_sha?: string;
    };
    if (!pr.merged || !pr.merge_commit_sha) {
      await send(chatId, `PR #${prNum} is not merged (state: ${pr.state}). Nothing to revert.`);
      return;
    }
    const sha = pr.merge_commit_sha;
    await send(
      chatId,
      [
        `PR #${prNum}: ${pr.title}`,
        `Merge SHA: ${sha.slice(0, 7)}`,
        ``,
        `Open the merge commit and click "Revert" — easiest path:`,
        `https://github.com/${repo}/commit/${sha}`,
        ``,
        `Or run on Mac (panel will need /sync after):`,
        `cd ~/splitbill && git checkout develop && git pull && git revert -m 1 ${sha} && git push`,
      ].join("\n"),
    );
  } catch (e) {
    await send(chatId, `revert lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── /agents ────────────────────────────────────────────────────────────

export async function handleAgents(chatId: number | string, send: SendFn): Promise<void> {
  const agents = await prisma.agent.findMany({ orderBy: { name: "asc" } });
  if (agents.length === 0) {
    await send(chatId, "No agents configured.");
    return;
  }
  const lines = agents.map((a) => {
    const tools = a.tools ? JSON.parse(a.tools) : null;
    const extras: string[] = [];
    if (tools?.claudeCodeAgentName) extras.push(`cc:${tools.claudeCodeAgentName}`);
    if (tools?.permissionMode) extras.push(`perm:${tools.permissionMode}`);
    if (Array.isArray(tools?.additionalDirectories)) extras.push(`dirs:${tools.additionalDirectories.length}`);
    if (typeof tools?.timeoutMs === "number") extras.push(`t:${tools.timeoutMs}ms`);
    return `${a.name.padEnd(28)}  ${a.backend.padEnd(22)}  ${a.model}${extras.length ? "  [" + extras.join(",") + "]" : ""}`;
  });
  await send(chatId, `Agents (${agents.length}):\n\n` + lines.join("\n"));
}
