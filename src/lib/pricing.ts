// USD per 1M tokens. Keep in sync with https://www.anthropic.com/pricing
// and https://openrouter.ai/models. Used to compute run cost.
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic direct
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-opus-4-5": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-haiku-4-5": { input: 1, output: 5 },

  // OpenRouter — Anthropic routes (same per-token prices as direct)
  "anthropic/claude-opus-4.5": { input: 15, output: 75 },
  "anthropic/claude-opus-4": { input: 15, output: 75 },
  "anthropic/claude-sonnet-4.5": { input: 3, output: 15 },
  "anthropic/claude-sonnet-4": { input: 3, output: 15 },
  "anthropic/claude-haiku-4.5": { input: 1, output: 5 },
};

export function priceFor(model: string): { input: number; output: number } {
  return MODEL_PRICING[model] ?? { input: 0, output: 0 };
}

export function computeCost(model: string, tokensIn: number, tokensOut: number): number {
  const p = priceFor(model);
  return (tokensIn * p.input + tokensOut * p.output) / 1_000_000;
}

export const AVAILABLE_MODELS = Object.keys(MODEL_PRICING);
