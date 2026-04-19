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

  const stream = await getClient().messages.stream(
    {
      model,
      max_tokens: 4096,
      system: systemPrompt ?? undefined,
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
