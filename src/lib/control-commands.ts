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
// /undo [confirm]    auto-detect most recent agent commit on splitbill
//                    develop and revert it (skips already-reverted)

import { exec as childExec } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "./prisma";
import { capStatus, setCap } from "./cost-cap";
import { killTask, listInflightTaskIds } from "./worker";

const execAsync = promisify(childExec);

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

// ── /undo ──────────────────────────────────────────────────────────────
//
// MVP heuristic: agent commits land on develop with a size tag prefix
// "[XS]", "[S]", "[M]", "[L]" (per the auto-merge / cc:software-engineer
// convention). Walk develop's recent history; skip commits that are
// already reverts ("Revert of...") or that contain "revert" in their
// message; the first remaining tagged commit is the candidate.
//
// /undo            → show the candidate, ask for confirm
// /undo confirm    → git revert + push to develop
//
// Why direct git on Mac (not GitHub Merge API): a revert via API
// requires building the inverse diff manually (3-way merge). git CLI
// already knows how, and the panel runs on the same Mac that hosts
// the splitbill clone. Pushes directly to develop, no PR ceremony.

const SPLITBILL_REPO_PATH = "/Users/alidenizaslan/splitbill";
const SPLITBILL_BRANCH = "develop";

interface RevertCandidate {
  sha: string;
  shortSha: string;
  message: string;
}

async function findRevertCandidate(): Promise<RevertCandidate | null> {
  // git log returns most recent first. We pull develop first to make
  // sure we're seeing the actual current head (in case the user merged
  // on iPad since the last /sync).
  const { stdout } = await execAsync(
    [
      `cd "${SPLITBILL_REPO_PATH}"`,
      `git fetch origin --prune`,
      `git checkout ${SPLITBILL_BRANCH}`,
      `git pull --ff-only origin ${SPLITBILL_BRANCH}`,
      `git log --pretty=format:'%H|%s' -20`,
    ].join(" && "),
    { timeout: 20_000 },
  );
  const lines = stdout.split("\n");
  for (const line of lines) {
    const [sha, ...rest] = line.split("|");
    const message = rest.join("|");
    if (!sha) continue;
    // Skip revert commits — don't undo an undo.
    if (/^revert\b/i.test(message) || /\bRevert "/.test(message)) continue;
    // Match agent size-tag prefix.
    if (/^\[(XS|S|M|L)\]/i.test(message)) {
      return { sha, shortSha: sha.slice(0, 7), message };
    }
  }
  return null;
}

export async function handleUndo(chatId: number | string, args: string, send: SendFn): Promise<void> {
  let candidate: RevertCandidate | null;
  try {
    candidate = await findRevertCandidate();
  } catch (e) {
    await send(
      chatId,
      `❌ /undo aday tespiti başarısız:\n${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  if (!candidate) {
    await send(
      chatId,
      "Son 20 develop commit'inde [XS]/[S]/[M]/[L] tag'li agent commit'i bulunamadı (veya hepsi zaten revert edilmiş). Hiçbir şey yapılmadı.",
    );
    return;
  }

  const confirm = args.trim().toLowerCase();
  if (confirm !== "confirm") {
    await send(
      chatId,
      [
        "Önerilen revert adayı (son agent commit'i):",
        ``,
        `${candidate.shortSha}  —  ${candidate.message.slice(0, 100)}`,
        ``,
        "Geri almak için: /undo confirm",
        "İptal etmek için: bu mesajı yoksay.",
      ].join("\n"),
    );
    return;
  }

  // Run the revert
  try {
    const { stdout, stderr } = await execAsync(
      [
        `cd "${SPLITBILL_REPO_PATH}"`,
        `git checkout ${SPLITBILL_BRANCH}`,
        `git pull --ff-only origin ${SPLITBILL_BRANCH}`,
        // --no-edit so we don't open an interactive editor;
        // squashed agent commits aren't merge commits so -m isn't needed.
        `git revert --no-edit ${candidate.sha}`,
        `git push origin ${SPLITBILL_BRANCH}`,
      ].join(" && "),
      { timeout: 60_000 },
    );
    const summary = [stdout, stderr].filter(Boolean).join("\n").trim();
    await send(
      chatId,
      [
        `✅ ${candidate.shortSha} revert edildi ve develop'a push'landı`,
        "",
        "Vercel ~2-3 dk içinde yeniden deploy edecek.",
        "",
        summary.length > 1500 ? summary.slice(0, 1500) + "\n[...kesildi]" : summary,
      ].join("\n"),
    );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    // Common failure: merge conflict during revert
    const isConflict =
      errMsg.includes("CONFLICT") ||
      errMsg.includes("could not revert") ||
      errMsg.includes("after resolving the conflicts");
    if (isConflict) {
      // Abort the partial revert so the working tree stays clean
      await execAsync(`cd "${SPLITBILL_REPO_PATH}" && git revert --abort || true`).catch(() => undefined);
      await send(
        chatId,
        [
          `❌ Revert sırasında merge conflict. Otomatik abort edildi, working tree temiz.`,
          "",
          `Bu commit elle düzeltmek gerekecek:`,
          `  ssh into Mac → cd ~/splitbill → git revert ${candidate.shortSha} → conflict'leri çöz → push`,
          ``,
          `Veya GitHub web'de manuel revert:`,
          `https://github.com/${process.env.GITHUB_REPO ?? "alideniz0710/splitbill"}/commit/${candidate.sha}`,
        ].join("\n"),
      );
    } else {
      await send(chatId, `❌ Revert başarısız:\n${errMsg.slice(0, 1500)}`);
    }
  }
}

// ── /backup ────────────────────────────────────────────────────────────

export async function handleBackup(chatId: number | string, args: string, send: SendFn): Promise<void> {
  const { listBackups, runBackup } = await import("./backup");
  const sub = args.trim().split(/\s+/)[0]?.toLowerCase() || "status";

  if (sub === "status") {
    if (!process.env.B2_BUCKET_NAME) {
      await send(chatId, "B2 configured değil. ~/.zshrc'ye B2_APPLICATION_KEY_ID/KEY/BUCKET_NAME ekle.");
      return;
    }
    try {
      const files = await listBackups();
      if (files.length === 0) {
        await send(
          chatId,
          "B2'de henüz backup yok. Bilinen ilk backup gece 03:00 Istanbul'da. Manuel istersen: /backup now",
        );
        return;
      }
      const newest = files[0];
      const totalSizeKb = files.reduce((s, f) => s + f.contentLength, 0) / 1024;
      const ageMs = Date.now() - newest.uploadTimestamp;
      const ageHours = Math.floor(ageMs / 3_600_000);
      const ageMin = Math.floor((ageMs % 3_600_000) / 60_000);
      await send(
        chatId,
        [
          `Backup status:`,
          `  Toplam: ${files.length} dosya, ${totalSizeKb.toFixed(1)} KB`,
          `  Son: ${newest.fileName}`,
          `         ${(newest.contentLength / 1024).toFixed(1)} KB, ${ageHours}h ${ageMin}m önce`,
          `  Schedule: günlük 03:00 Europe/Istanbul, son 14 tutuluyor`,
          ``,
          `Manuel tetikle: /backup now`,
        ].join("\n"),
      );
    } catch (e) {
      await send(chatId, `❌ /backup status hatası: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (sub === "now") {
    if (!process.env.B2_BUCKET_NAME) {
      await send(chatId, "B2 configured değil.");
      return;
    }
    await send(chatId, "⏳ Backup başlıyor...");
    try {
      const result = await runBackup();
      await send(
        chatId,
        `✅ Backup yüklendi:\n${result.fileName}\n${(result.sizeBytes / 1024).toFixed(1)} KB, ${result.durationMs}ms`,
      );
    } catch (e) {
      await send(chatId, `❌ Backup hatası:\n${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  await send(chatId, "Usage: /backup status  |  /backup now");
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

// ── /cost ──────────────────────────────────────────────────────────────
//
// Per-agent + total cost breakdown for the last N hours (default 24).
// Helps founder see which agent is burning money so they can adjust:
//   - the daily /cap value
//   - which agent gets which kinds of tasks
//   - whether memory writes are helping (compare before/after Korea)
//
// Reads from prisma.task — relies on cost being persisted per task by
// the worker. We aggregate locally; cheap.

export async function handleCost(chatId: number | string, args: string, send: SendFn): Promise<void> {
  const hoursArg = parseInt(args.trim(), 10);
  const hours = isNaN(hoursArg) || hoursArg <= 0 ? 24 : Math.min(hoursArg, 24 * 30);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const tasks = await prisma.task.findMany({
    where: { startedAt: { gte: since } },
    select: { cost: true, status: true, tokensIn: true, tokensOut: true, agent: { select: { name: true } } },
  });
  if (tasks.length === 0) {
    await send(chatId, `Son ${hours} saatte hiç görev çalışmamış.`);
    return;
  }

  type AgentSummary = { name: string; cost: number; count: number; failed: number; tokensIn: number; tokensOut: number };
  const byAgent = new Map<string, AgentSummary>();
  let total = 0;
  let totalFailed = 0;
  for (const t of tasks) {
    const name = t.agent?.name ?? "(unknown)";
    const existing = byAgent.get(name) ?? { name, cost: 0, count: 0, failed: 0, tokensIn: 0, tokensOut: 0 };
    existing.cost += t.cost ?? 0;
    existing.count += 1;
    existing.tokensIn += t.tokensIn ?? 0;
    existing.tokensOut += t.tokensOut ?? 0;
    if (t.status === "failed" || t.status === "timeout") existing.failed += 1;
    byAgent.set(name, existing);
    total += t.cost ?? 0;
    if (t.status === "failed" || t.status === "timeout") totalFailed += 1;
  }

  const sorted = Array.from(byAgent.values()).sort((a, b) => b.cost - a.cost);
  const lines = [
    `📊 Son ${hours} saat cost dağılımı`,
    "",
    `Toplam: $${total.toFixed(3)} (${tasks.length} görev, ${totalFailed} fail)`,
    "",
    "Agent başına:",
  ];
  for (const a of sorted) {
    const failTag = a.failed > 0 ? ` (${a.failed} fail!)` : "";
    lines.push(
      `  ${a.name.padEnd(28)} $${a.cost.toFixed(3).padStart(7)}  ${a.count} task${a.count > 1 ? "s" : ""}${failTag}`,
    );
  }
  // Cost-saving hint: if failure rate > 25%, surface it
  if (tasks.length >= 4 && totalFailed / tasks.length > 0.25) {
    lines.push("");
    lines.push(
      `⚠️ Failure oranı %${Math.round((totalFailed / tasks.length) * 100)} — agent'lar tekrar tekrar fail ediyor. memory/agents/<name>.md dosyalarına bak, son fail kayıtları orada birikiyor.`,
    );
  }
  await send(chatId, lines.join("\n"));
}

// ── /memo ──────────────────────────────────────────────────────────────
//
// Adds an entry to the agent memory system, either to shared.md or to a
// specific agent's file. Each entry is auto-timestamped (UTC ISO) so
// the diff history is meaningful when reviewing later.
//
// Syntax:
//   /memo <text>                       → appends to memory/shared.md
//   /memo <agent-slug> <text>          → appends to memory/agents/<slug>.md
//
// Where <agent-slug> is one of: software-engineer, debug, personal-assistant
// (we accept the bare slug, NOT "cc:software-engineer" — easier to type
// on a phone keyboard).

const KNOWN_AGENT_SLUGS: ReadonlySet<string> = new Set([
  "software-engineer",
  "debug",
  "personal-assistant",
  "pilot",
  "data-analyst",
]);

export async function handleMemo(chatId: number | string, args: string, send: SendFn): Promise<void> {
  const text = args.trim();
  if (!text) {
    await send(
      chatId,
      [
        "Memory'ye not eklemek için:",
        "",
        "  /memo <text>                            → shared.md'ye ekler",
        "  /memo software-engineer <text>          → agent dosyasına ekler",
        "  /memo debug <text>",
        "  /memo personal-assistant <text>",
        "",
        "Notlar otomatik tarih damgalı eklenir. Bir sonraki agent çağrısında yansır.",
      ].join("\n"),
    );
    return;
  }

  // Detect optional agent slug as first word
  const firstSpace = text.indexOf(" ");
  let agentName: string | undefined;
  let body: string;
  if (firstSpace > 0) {
    const head = text.slice(0, firstSpace);
    if (KNOWN_AGENT_SLUGS.has(head)) {
      agentName = `cc:${head}`;
      body = text.slice(firstSpace + 1).trim();
    } else {
      body = text;
    }
  } else {
    body = text;
  }

  if (!body) {
    await send(chatId, `Agent slug verdiğin ama metin boş. Örnek: /memo software-engineer 'Use App Router not Pages'`);
    return;
  }

  try {
    const { appendMemoryEntry } = await import("./memory");
    const result = await appendMemoryEntry(body, agentName ? { agentName } : {});
    const fileLabel = agentName ? `agents/${agentName.replace(/^cc:/, "")}.md` : "shared.md";
    await send(
      chatId,
      `✅ memory/${fileLabel}'e not eklendi (toplam ${(result.bytes / 1024).toFixed(1)}KB)\n\nBir sonraki agent çağrısında yansır.`,
    );
  } catch (e) {
    await send(chatId, `❌ memo yazılamadı: ${e instanceof Error ? e.message : String(e)}`);
  }
}
