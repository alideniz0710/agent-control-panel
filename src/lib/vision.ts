// Telegram photo → Claude Vision analysis → text description.
//
// Flow:
//   1. Telegram poller sees msg.photo in an update
//   2. We fetch file metadata via Telegram API (getFile)
//   3. Download the JPEG
//   4. POST to Claude claude-3-5-sonnet-20241022 as a base64 image block
//   5. Return the description; caller builds the combined text and
//      dispatches through the same orchestrator path as plain text
//
// Failure modes:
//   - ANTHROPIC_API_KEY not set → throws; caller surfaces error to chat
//   - TELEGRAM_BOT_TOKEN not set → throws
//   - Telegram getFile / download fails → throws
//   - Claude returns no text block → throws

import Anthropic from "@anthropic-ai/sdk";

const CLAUDE_VISION_MODEL = "claude-3-5-sonnet-20241022";

type SupportedMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

interface TelegramFileResponse {
  ok: boolean;
  result?: {
    file_id: string;
    file_size?: number;
    file_path: string;
  };
}

/** Download a Telegram photo by file_id and return its raw bytes. */
export async function downloadTelegramPhoto(
  fileId: string,
): Promise<{ buffer: Buffer; mime: string; filename: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

  const metaRes = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  if (!metaRes.ok) {
    throw new Error(`telegram getFile failed: ${metaRes.status}`);
  }
  const meta = (await metaRes.json()) as TelegramFileResponse;
  if (!meta.ok || !meta.result?.file_path) {
    throw new Error("telegram getFile returned no path");
  }

  const fileUrl = `https://api.telegram.org/file/bot${token}/${meta.result.file_path}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) {
    throw new Error(`telegram file download failed: ${fileRes.status}`);
  }
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  const filename = meta.result.file_path.split("/").pop() ?? "photo.jpg";
  const ext = filename.split(".").pop()?.toLowerCase();
  const mime: SupportedMediaType =
    ext === "png" ? "image/png" :
    ext === "gif" ? "image/gif" :
    ext === "webp" ? "image/webp" :
    "image/jpeg";
  return { buffer, mime, filename };
}

/** Send an image buffer to Claude Vision and return the description. */
export async function analyzeWithClaude(imageBuf: Buffer, hint?: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const client = new Anthropic();
  const promptText = hint
    ? `Bu görseli kısaca açıkla. Bağlam: ${hint}`
    : "Bu görseli kısaca açıkla.";

  const message = await client.messages.create({
    model: CLAUDE_VISION_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: imageBuf.toString("base64"),
            },
          },
          { type: "text", text: promptText },
        ],
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }
  return textBlock.text.trim();
}
