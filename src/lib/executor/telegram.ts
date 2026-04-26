// Telegram notification executor.
//
// Use this backend when you want a workflow step to send a message to
// Telegram instead of calling an LLM. It is NOT an LLM call — token
// usage and cost are always 0.
//
// Required env:
//   TELEGRAM_BOT_TOKEN  — from @BotFather
//   TELEGRAM_CHAT_ID    — the chat to send to (default for all telegram
//                         agents; can be overridden per-agent via tools)
//
// Optional per-agent overrides (set in Agent.tools as JSON):
//   { "chatId": "<chat-id-override>", "parseMode": "Markdown" | "HTML" }
//
// Agent.model can be any string (it's not used). Convention: "telegram-bot".
//
// Input is sent verbatim as the message body — typically you'd put
// something like "🚨 Alert: {{previousOutput}}" in the step's
// inputTemplate and let the chain feed in.

import type { Executor } from "./types";

type TelegramTools = {
  chatId?: string;
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
};

function parseTools(tools: unknown): TelegramTools {
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return {};
  const obj = tools as Record<string, unknown>;
  const out: TelegramTools = {};
  if (typeof obj.chatId === "string" && obj.chatId.length > 0) out.chatId = obj.chatId;
  if (typeof obj.parseMode === "string") {
    if (obj.parseMode === "Markdown" || obj.parseMode === "MarkdownV2" || obj.parseMode === "HTML") {
      out.parseMode = obj.parseMode;
    }
  }
  return out;
}

export const telegramExecutor: Executor = async ({ userInput, tools, onLog, signal }) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }

  const opts = parseTools(tools);
  const chatId = opts.chatId ?? process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    throw new Error("TELEGRAM_CHAT_ID is not set (and no chatId in agent.tools)");
  }

  // Telegram caps text at 4096 chars per message.
  const text = userInput.length > 4096 ? userInput.slice(0, 4093) + "..." : userInput;

  onLog({ level: "info", text: `sending to telegram chat ${chatId} (${text.length} chars)` });

  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (opts.parseMode) body.parse_mode = opts.parseMode;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "(unreadable response)");
    throw new Error(`telegram api ${res.status}: ${errText}`);
  }

  const data = (await res.json().catch(() => null)) as { result?: { message_id?: number } } | null;
  const messageId = data?.result?.message_id;
  onLog({ level: "stdout", text: messageId ? `sent (message_id=${messageId})` : "sent" });

  return {
    output: messageId ? `telegram:sent:${messageId}` : "telegram:sent",
    tokensIn: 0,
    tokensOut: 0,
  };
};
