// OpenRouter executor (OpenAI-compatible chat completions API).
// Uses SSE streaming via raw fetch — no new dependency.
// Docs: https://openrouter.ai/docs/api-reference/chat-completion

import type { Executor } from "./types";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

type Delta = { content?: string };
type Choice = { delta?: Delta; finish_reason?: string | null };
type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
};
type StreamChunk = {
  id?: string;
  choices?: Choice[];
  usage?: Usage;
};

export const openrouterExecutor: Executor = async ({
  model,
  systemPrompt,
  userInput,
  onLog,
  signal,
}) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  onLog({ level: "info", text: `calling openrouter ${model}` });

  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userInput });

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://agent-control-panel.local",
      "X-Title": "Agent Control Panel",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      usage: { include: true },
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`openrouter http ${res.status}: ${body.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let reportedCost: number | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        // Each event may have multiple `data:` lines (rare here); concatenate.
        const dataLines = rawEvent
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());

        if (dataLines.length === 0) continue;
        const payload = dataLines.join("\n");
        if (payload === "[DONE]") continue;

        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(payload) as StreamChunk;
        } catch {
          // OpenRouter sometimes sends keep-alive comments (": OPENROUTER PROCESSING").
          continue;
        }

        const piece = chunk.choices?.[0]?.delta?.content;
        if (piece) {
          text += piece;
          onLog({ level: "stdout", text: piece });
        }

        if (chunk.usage) {
          tokensIn = chunk.usage.prompt_tokens ?? tokensIn;
          tokensOut = chunk.usage.completion_tokens ?? tokensOut;
          if (typeof chunk.usage.cost === "number") {
            reportedCost = chunk.usage.cost;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (reportedCost !== null) {
    onLog({
      level: "info",
      text: `openrouter reported cost: $${reportedCost.toFixed(6)} (tokens ${tokensIn}/${tokensOut})`,
    });
  }

  return { output: text, tokensIn, tokensOut };
};
