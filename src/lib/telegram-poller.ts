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
  SYSTEM_COMMANDS,
  TELEGRAM_COMMAND_ROUTES,
} from "./telegram-router";
import { handleSyncCommand } from "./telegram-system-commands";

const POLL_TIMEOUT_SECONDS = 25;     // long-poll: server waits this long for a message
const ERROR_BACKOFF_MS = 10_000;     // pause this long after a network/api error
const STATE_KEY = "telegram-poller:lastUpdateId";

let started = false;
let polling = false;
let stopped = false;
let lastUpdateId = 0;

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
  // commands. Stored in a tiny KV row in a Setting table — but the
  // current schema has no such table, so we fall back to a single-row
  // strategy via the runs table's metadata. To stay schema-clean, we
  // keep it in-memory only and accept that messages sent while the
  // poller is offline get processed once on boot. Telegram itself
  // drops updates older than 24h, which is the natural ceiling.
  return 0;
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

  // System commands: handled inline by the poller, not via workflows.
  if (SYSTEM_COMMANDS.has(parsed.command)) {
    if (parsed.command === "sync") {
      await handleSyncCommand(msg.chat.id, sendTelegram);
      return;
    }
    // Future system commands wire in here.
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

  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=${POLL_TIMEOUT_SECONDS}`;
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

  for (const update of data.result) {
    lastUpdateId = Math.max(lastUpdateId, update.update_id);
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
  }
}

async function loop(): Promise<void> {
  while (!stopped) {
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
  if (started) return;
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log("[telegram-poller] TELEGRAM_BOT_TOKEN not set — skipping");
    return;
  }
  started = true;
  void loadOffset().then((offset) => {
    lastUpdateId = offset;
  });
  console.log(
    `[telegram-poller] started (commands: ${TELEGRAM_COMMAND_ROUTES.map((r) => "/" + r.command).join(", ")})`,
  );
  void loop();
}

export function stopTelegramPoller(): void {
  stopped = true;
}
