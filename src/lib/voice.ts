// Telegram voice message → Whisper transcription → orchestrator dispatch.
//
// Why: walking, eating, jet-lagged in Seoul. Typing Turkish prompts on
// phone is the bottleneck for a non-dev founder driving the panel from
// abroad. Voice cuts the friction by ~5x.
//
// Flow:
//   1. Telegram poller sees msg.voice in an update
//   2. We fetch the file metadata via Telegram API (getFile)
//   3. Download the OGG/Opus audio
//   4. POST to OpenAI Whisper (translates+transcribes Turkish accurately)
//   5. Return the transcribed text; caller dispatches it through the
//      same orchestrator path that handles plain text
//
// Cost: ~$0.006 per minute of audio. 10 voice msgs/day @ 30s avg ≈
// $0.03/month. Negligible.
//
// Failure modes:
//   - OPENAI_API_KEY not set → returns null; poller falls back to a
//     "voice transcription not configured" reply
//   - Telegram getFile fails → throws, poller surfaces as error
//   - Whisper rejects (rate, bad audio) → throws

const WHISPER_MODEL = "whisper-1";

export interface VoiceMessage {
  file_id: string;
  file_unique_id?: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramFileResponse {
  ok: boolean;
  result?: {
    file_id: string;
    file_size?: number;
    file_path: string;
  };
}

/** Download Telegram voice file as a Buffer. */
async function downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; mime: string; filename: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

  // Step 1: get file path
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

  // Step 2: download the actual file
  const fileUrl = `https://api.telegram.org/file/bot${token}/${meta.result.file_path}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) {
    throw new Error(`telegram file download failed: ${fileRes.status}`);
  }
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  // Telegram voice messages are always OGG/Opus
  const filename = meta.result.file_path.split("/").pop() ?? "voice.ogg";
  const mime = filename.endsWith(".ogg") ? "audio/ogg" : "audio/mpeg";
  return { buffer, mime, filename };
}

/** Send audio to OpenAI Whisper and get back the transcription. */
async function whisperTranscribe(audio: Buffer, mime: string, filename: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");

  const form = new FormData();
  const blob = new Blob([new Uint8Array(audio)], { type: mime });
  form.append("file", blob, filename);
  form.append("model", WHISPER_MODEL);
  // Hint: founder mostly speaks Turkish. Whisper auto-detects but
  // hint helps on short/noisy clips.
  form.append("language", "tr");
  // We want plain text (no timestamps) for the orchestrator
  form.append("response_format", "text");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`whisper failed: ${res.status} ${errText.slice(0, 300)}`);
  }
  const text = await res.text();
  return text.trim();
}

/** End-to-end: voice file_id → transcribed text. Throws on any failure
 *  EXCEPT when env keys are missing, in which case it returns null so
 *  the caller can render a configuration hint to the user instead of
 *  blowing up. */
export async function transcribeVoice(voice: VoiceMessage): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }
  const { buffer, mime, filename } = await downloadTelegramFile(voice.file_id);
  return whisperTranscribe(buffer, mime, filename);
}
