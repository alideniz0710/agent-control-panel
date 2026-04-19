import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Executor } from "./types";

export const claudeAgentSdkExecutor: Executor = async ({
  model,
  systemPrompt,
  userInput,
  onLog,
  signal,
}) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  onLog({ level: "info", text: `starting Claude Agent SDK session (${model})` });

  const options: Record<string, unknown> = { model };
  if (systemPrompt) {
    options.systemPrompt = { type: "preset", preset: "claude_code", append: systemPrompt };
  }
  if (signal) options.abortSignal = signal;

  const iter = query({ prompt: userInput, options: options as never });

  let finalText = "";
  let tokensIn = 0;
  let tokensOut = 0;

  for await (const msg of iter) {
    const m = msg as { type?: string; [k: string]: unknown };
    if (m.type === "assistant") {
      const content = (m.message as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          onLog({ level: "stdout", text: block.text });
        } else if (block.type === "tool_use") {
          onLog({ level: "tool", text: `tool: ${(block as { name?: string }).name ?? "unknown"}` });
        }
      }
    } else if (m.type === "result") {
      const result = m as {
        subtype: string;
        result?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
        is_error?: boolean;
      };
      if (result.subtype === "success") {
        finalText = result.result ?? finalText;
        tokensIn = result.usage?.input_tokens ?? 0;
        tokensOut = result.usage?.output_tokens ?? 0;
      } else {
        throw new Error(`agent sdk failed: ${JSON.stringify(result)}`);
      }
    }
  }

  return { output: finalText, tokensIn, tokensOut };
};
