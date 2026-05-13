import Anthropic from "@anthropic-ai/sdk";
import type { Executor } from "./types";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export const anthropicApiExecutor: Executor = async ({
  model,
  systemPrompt,
  userInput,
  onLog,
  signal,
}) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  onLog({ level: "info", text: `calling ${model}` });

  // Prompt caching — Anthropic ephemeral cache marks the system prompt
  // as a stable prefix that subsequent calls (within 5 min, same prefix)
  // can reuse. Input tokens on the cached portion charge at 10% of the
  // normal rate. Worth it for orchestrator-router etc. that get called
  // many times back-to-back with a static system prompt.
  // Threshold: caching only activates if the cached content is >1024
  // tokens (Sonnet) or >2048 (Haiku); below that, marking has no effect
  // but doesn't hurt either.
  const systemBlocks = systemPrompt
    ? [
        {
          type: "text" as const,
          text: systemPrompt,
          cache_control: { type: "ephemeral" as const },
        },
      ]
    : undefined;

  const stream = await getClient().messages.stream(
    {
      model,
      max_tokens: 4096,
      system: systemBlocks,
      messages: [{ role: "user", content: userInput }],
    },
    signal ? { signal } : undefined,
  );

  let text = "";
  stream.on("text", (chunk) => {
    text += chunk;
    onLog({ level: "stdout", text: chunk });
  });

  const final = await stream.finalMessage();
  const tokensIn = final.usage?.input_tokens ?? 0;
  const tokensOut = final.usage?.output_tokens ?? 0;

  return { output: text, tokensIn, tokensOut };
};
