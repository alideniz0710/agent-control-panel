import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Executor } from "./types";

const VALID_PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan"] as const;
type PermissionMode = (typeof VALID_PERMISSION_MODES)[number];

export const claudeAgentSdkExecutor: Executor = async ({
  model,
  systemPrompt,
  userInput,
  tools,
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

  const cwd = parseCwd(tools);
  if (cwd) {
    options.cwd = cwd;
    onLog({ level: "info", text: `cwd set to ${cwd}` });
  }

  const additionalDirectories = parseAdditionalDirectories(tools);
  if (additionalDirectories.length > 0) {
    options.additionalDirectories = additionalDirectories;
    onLog({ level: "info", text: `additionalDirectories: ${additionalDirectories.join(", ")}` });
  }

  const permissionMode = parsePermissionMode(tools);
  if (permissionMode) {
    options.permissionMode = permissionMode;
    onLog({ level: "info", text: `permissionMode: ${permissionMode}` });
  }

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

function parseCwd(tools: unknown): string | null {
  if (tools && typeof tools === "object" && !Array.isArray(tools)) {
    const v = (tools as Record<string, unknown>).cwd;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function parseAdditionalDirectories(tools: unknown): string[] {
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return [];
  const v = (tools as Record<string, unknown>).additionalDirectories;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function parsePermissionMode(tools: unknown): PermissionMode | null {
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return null;
  const v = (tools as Record<string, unknown>).permissionMode;
  if (typeof v !== "string") return null;
  return (VALID_PERMISSION_MODES as readonly string[]).includes(v) ? (v as PermissionMode) : null;
}
