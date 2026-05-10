// Telegram polling worker.
//
// Long-polls Telegram's getUpdates endpoint. When a message arrives in
// the configured chat, it parses the command and triggers the matching
// workflow with the message text (after the command) as the first-step
// input override. The workflow's terminal Telegram step delivers the
// agent's response back to the same chat.
//
// Why polling, not webhook: works without exposing the panel publicly.
// Trade-off: 1–10 second latency between message and ack.
//
// Started from instrumentation.ts on Node boot. Fails open if env is
// missing — no token / chat id, no polling, panel keeps running.

import { prisma } from "./prisma";
import { startRun } from "./workflow";
import {
  parseCommand,
  findRoute,
  buildHelp,
  checkDangerous,
  SYSTEM_COMMANDS,
  TELEGRAM_COMMAND_ROUTES,
} from "./telegram-router";
import { handleSyncCommand } from "./telegram-system-commands";
import {
  handlePing,
  handleAuto,
  handleCap,
  handleKill,
  handleDeploy,
  handleRevert,
  handleAgents,
} from "./control-commands";

const POLL_TIMEOUT_SECONDS = 25;     // long-poll: server waits this long for a message
const ERROR_BACKOFF_MS = 10_000;     // pause this long after a network/api error
const STATE_KEY = "telegram.lastUpdateId";

// Idempotency cap: how many recent message_ids to remember in-process
// so a poller restart that re-fetches a still-acked message (race with
// Telegram's offset semantics) doesn't double-handle. Bounded set.
const PROCESSED_MSGS_MAX = 500;

// Why globalThis: Next.js can have separate module bundles for the
// instrumentation hook (where the poller starts) vs route handlers
// (where pollerStatus() is called by /api/health). Module-scoped state
// would diverge — the route's pollerStatus would always say
// `started: false` even though the instrumentation already started it.
type PollerGlobal = {
  pollerStarted?: boolean;
  pollerStopped?: boolean;
  pollerLastUpdateId?: number;
  pollerProcessedIds?: Set<number>;
};
const globalForPoller = globalThis as unknown as PollerGlobal;

let polling = false;
const processedMessageIds =
  globalForPoller.pollerProcessedIds ?? new Set<number>();
globalForPoller.pollerProcessedIds = processedMessageIds;

function rememberProcessed(updateId: number): void {
  if (processedMessageIds.size >= PROCESSED_MSGS_MAX) {
    // Drop the oldest ~half to keep the set bounded.
    const drop = Math.floor(PROCESSED_MSGS_MAX / 2);
    let i = 0;
    for (const id of processedMessageIds) {
      if (i++ >= drop) break;
      processedMessageIds.delete(id);
    }
  }
  processedMessageIds.add(updateId);
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number | string };
    from?: { id: number | string; first_name?: string };
  };
}

interface TelegramReply {
  ok: boolean;
  result?: TelegramUpdate[];
  error_code?: number;
  description?: string;
}

async function loadOffset(): Promise<number> {
  // Persist last_update_id across restarts so we don't replay old
  // commands. Stored in the Setting table (key="telegram.lastUpdateId").
  try {
    const row = await prisma.setting.findUnique({ where: { key: STATE_KEY } });
    if (!row) return 0;
    const n = parseInt(row.value, 10);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    console.error("[telegram-poller] loadOffset failed:", e);
    return 0;
  }
}

async function saveOffset(updateId: number): Promise<void> {
  try {
    await prisma.setting.upsert({
      where: { key: STATE_KEY },
      create: { key: STATE_KEY, value: String(updateId) },
      update: { value: String(updateId) },
    });
  } catch (e) {
    console.error("[telegram-poller] saveOffset failed:", e);
  }
}

async function sendTelegram(chatId: number | string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const safe = text.length > 4096 ? text.slice(0, 4093) + "..." : text;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: safe }),
    });
  } catch (e) {
    console.error("[telegram-poller] sendTelegram failed:", e);
  }
}

async function handleMessage(msg: NonNullable<TelegramUpdate["message"]>): Promise<void> {
  if (!msg.text) return;

  // Single-user mode: only respond to the configured chat.
  const expectedChatId = process.env.TELEGRAM_CHAT_ID;
  if (expectedChatId && String(msg.chat.id) !== String(expectedChatId)) {
    console.log(`[telegram-poller] ignoring message from chat ${msg.chat.id} (expected ${expectedChatId})`);
    return;
  }

  const parsed = parseCommand(msg.text);
  if (!parsed) {
    // Plain text: we don't engage. Optional: gentle "use /help" reminder.
    return;
  }

  if (parsed.command === "help" || parsed.command === "start") {
    await sendTelegram(msg.chat.id, buildHelp());
    return;
  }

  // System / control commands: handled inline by the poller, not via
  // workflows. They run on the priority path so they reply fast even
  // when the worker is busy with a long-running agent task.
  if (SYSTEM_COMMANDS.has(parsed.command)) {
    switch (parsed.command) {
      case "sync":
        await handleSyncCommand(msg.chat.id, sendTelegram);
        return;
      case "ping":
        await handlePing(msg.chat.id, sendTelegram);
        return;
      case "auto":
        await handleAuto(msg.chat.id, parsed.args, sendTelegram);
        return;
      case "cap":
        await handleCap(msg.chat.id, parsed.args, sendTelegram);
        return;
      case "kill":
        await handleKill(msg.chat.id, parsed.args, sendTelegram);
        return;
      case "deploy":
        await handleDeploy(msg.chat.id, parsed.args, sendTelegram);
        return;
      case "revert":
        await handleRevert(msg.chat.id, parsed.args, sendTelegram);
        return;
      case "agents":
        await handleAgents(msg.chat.id, sendTelegram);
        return;
    }
  }

  // /brief is intentionally NOT routed here — it's handled by the
  // pre-existing scheduled brief workflows. If a user types /brief
  // morning manually, ignore it; the morning-brief workflow fires on
  // its own schedule.
  if (parsed.command === "brief") {
    await sendTelegram(
      msg.chat.id,
      "Brief'ler 08:00 ve 22:00'de otomatik düşüyor. Manuel istersen /pa <konu> kullan.",
    );
    return;
  }

  const route = findRoute(parsed.command);
  if (!route) {
    await sendTelegram(
      msg.chat.id,
      `Bilinmeyen komut: /${parsed.command}\n\n${buildHelp()}`,
    );
    return;
  }

  if (!parsed.args) {
    await sendTelegram(
      msg.chat.id,
      `Boş görev. Örnek: /${parsed.command} <yapılacak iş>`,
    );
    return;
  }

  // Refuse obviously destructive prompts unless explicit confirmation.
  const danger = checkDangerous(parsed.args);
  if (danger.isDangerous && !danger.hasConfirm) {
    await sendTelegram(
      msg.chat.id,
      `🛑 Tehlikeli komut/şekilde algılandı: ${danger.matched?.join(", ")}\n\n` +
        "Eğer GERÇEKTEN bunu istiyorsan, mesajının sonuna `[confirm]` ekle ve tekrar gönder. " +
        "Aksi halde agent yanlış anlama ile bunu yapabilir.",
    );
    return;
  }

  const workflow = await prisma.workflow.findFirst({
    where: { name: route.workflowName, enabled: true },
  });
  if (!workflow) {
    await sendTelegram(
      msg.chat.id,
      `Hata: '${route.workflowName}' workflow'u bulunamadı veya disabled. Panel'de oluştur.`,
    );
    return;
  }

  // Conversation thread: pull the most recent done run for this
  // chat+command pair within the last hour, and prepend its first-task
  // input/output as "previous exchange" so the agent sees what we
  // were just talking about. Without this, every /se call is a fresh
  // session with no memory of "the plan we just made".
  const augmentedInput = await augmentWithPriorContext(
    String(msg.chat.id),
    parsed.command,
    parsed.args,
  );

  await sendTelegram(msg.chat.id, `⏳ /${parsed.command}: ${route.description} çalışıyor...`);

  try {
    const runId = await startRun(workflow.id, "telegram", augmentedInput, {
      chatId: String(msg.chat.id),
      telegramCommand: parsed.command,
    });
    console.log(`[telegram-poller] /${parsed.command} → run ${runId}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sendTelegram(msg.chat.id, `❌ Workflow hatası: ${message}`);
  }
}

/** Window we consider for "recent enough" prior exchange. Anything
 * older than this is treated as a fresh conversation, not a follow-up. */
const CONVERSATION_WINDOW_MS = 60 * 60 * 1000; // 1 hour

async function augmentWithPriorContext(
  chatId: string,
  command: string,
  newInput: string,
): Promise<string> {
  const cutoff = new Date(Date.now() - CONVERSATION_WINDOW_MS);
  const prior = await prisma.run.findFirst({
    where: {
      chatId,
      telegramCommand: command,
      status: "done",
      finishedAt: { gte: cutoff },
    },
    orderBy: { finishedAt: "desc" },
    include: {
      tasks: { orderBy: { stepOrder: "asc" }, take: 1 },
    },
  });

  if (!prior || prior.tasks.length === 0) return newInput;

  const priorTask = prior.tasks[0];
  // priorTask.input is the augmented input we sent the LAST time —
  // possibly already containing earlier context. Don't recursively
  // pile that on. Use only the OUTPUT (the agent's answer) and a
  // best-effort "your previous question" extracted from input.
  const priorAnswer = (priorTask.output ?? "").trim();
  if (!priorAnswer) return newInput;

  return [
    "[Bu konuşmada az önce şunu cevapladın:]",
    "",
    priorAnswer.length > 4000 ? priorAnswer.slice(0, 4000) + "\n[...kesildi]" : priorAnswer,
    "",
    "[Yeni mesajım — yukarıdaki cevabını referans alarak yanıtla:]",
    "",
    newInput,
  ].join("\n");
}

async function pollOnce(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${(globalForPoller.pollerLastUpdateId ?? 0) + 1}&timeout=${POLL_TIMEOUT_SECONDS}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    console.error("[telegram-poller] fetch failed:", e);
    await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
    return;
  }

  if (!res.ok) {
    console.error(`[telegram-poller] getUpdates http ${res.status}`);
    await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
    return;
  }

  let data: TelegramReply;
  try {
    data = (await res.json()) as TelegramReply;
  } catch (e) {
    console.error("[telegram-poller] json parse failed:", e);
    return;
  }

  if (!data.ok || !data.result) return;

  const startUpdateId = globalForPoller.pollerLastUpdateId ?? 0;
  let highestUpdateId = startUpdateId;
  for (const update of data.result) {
    highestUpdateId = Math.max(highestUpdateId, update.update_id);
    if (processedMessageIds.has(update.update_id)) {
      // Already handled in a previous loop tick (defensive — shouldn't
      // happen with proper offset tracking, but Telegram occasionally
      // re-delivers if ack is slow).
      continue;
    }
    if (update.message) {
      try {
        await handleMessage(update.message);
      } catch (e) {
        console.error("[telegram-poller] handleMessage failed:", e);
        await sendTelegram(
          update.message.chat.id,
          `❌ İç hata: ${e instanceof Error ? e.message : String(e)}`,
        ).catch(() => undefined);
      }
    }
    rememberProcessed(update.update_id);
  }

  if (highestUpdateId > startUpdateId) {
    globalForPoller.pollerLastUpdateId = highestUpdateId;
    // Persist immediately so a crash between batches doesn't replay.
    void saveOffset(highestUpdateId);
  }
}

async function loop(): Promise<void> {
  while (!globalForPoller.pollerStopped) {
    if (polling) return; // safety
    polling = true;
    try {
      await pollOnce();
    } catch (e) {
      console.error("[telegram-poller] loop error:", e);
      await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
    } finally {
      polling = false;
    }
  }
}

export function startTelegramPoller(): void {
  if (globalForPoller.pollerStarted) return;
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log("[telegram-poller] TELEGRAM_BOT_TOKEN not set — skipping");
    return;
  }
  globalForPoller.pollerStarted = true;
  globalForPoller.pollerStopped = false;
  // Load persisted offset BEFORE starting the loop, so we don't briefly
  // window-replay old messages while the async load is in flight.
  void loadOffset().then((offset) => {
    globalForPoller.pollerLastUpdateId = offset;
    console.log(
      `[telegram-poller] started (commands: ${TELEGRAM_COMMAND_ROUTES.map((r) => "/" + r.command).join(", ")}; resume offset=${offset})`,
    );
    void loop();
  });
}

/** Exposed for /api/health endpoint. */
export function pollerStatus(): { started: boolean; lastUpdateId: number; processedCount: number } {
  return {
    started: Boolean(globalForPoller.pollerStarted),
    lastUpdateId: globalForPoller.pollerLastUpdateId ?? 0,
    processedCount: processedMessageIds.size,
  };
}

export function stopTelegramPoller(): void {
  globalForPoller.pollerStopped = true;
}
