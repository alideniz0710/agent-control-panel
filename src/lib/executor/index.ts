import { fakeExecutor } from "./fake";
import { anthropicApiExecutor } from "./anthropicApi";
import { claudeAgentSdkExecutor } from "./claudeAgentSdk";
import { claudeCodeAgentExecutor } from "./claudeCodeAgent";
import { openrouterExecutor } from "./openrouter";
import { openrouterCodeAgentExecutor } from "./openrouterCodeAgent";
import type { Executor } from "./types";

export const BACKENDS = [
  "claude-agent-sdk",
  "claude-code-agent",
  "anthropic-api",
  "openrouter",
  "openrouter-code-agent",
  "fake",
] as const;
export type Backend = (typeof BACKENDS)[number];

export function getExecutor(backend: string): Executor {
  switch (backend) {
    case "claude-agent-sdk":
      return claudeAgentSdkExecutor;
    case "claude-code-agent":
      return claudeCodeAgentExecutor;
    case "anthropic-api":
      return anthropicApiExecutor;
    case "openrouter":
      return openrouterExecutor;
    case "openrouter-code-agent":
      return openrouterCodeAgentExecutor;
    case "fake":
      return fakeExecutor;
    default:
      throw new Error(`unknown backend: ${backend}`);
  }
}

export type { Executor } from "./types";
