// USD per 1M tokens. Used to compute run cost for the dashboard.
//
// Prices need periodic verification. OpenRouter reports actual cost
// per request via `usage.cost` (logged as info by openrouter executor),
// so even stale prices here don't break billing — they just make the
// dashboard's computed total slightly off.
//
// Sources to check when updating:
//   - Anthropic direct: https://www.anthropic.com/pricing
//   - OpenRouter catalog: https://openrouter.ai/models
//
// Convention: keep Anthropic direct IDs (kebab) AND OpenRouter IDs
// (provider/slug) together so the same model's two routes share pricing.

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // ── Anthropic direct ────────────────────────────────────────────────
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-opus-4-5": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-haiku-4-5": { input: 1, output: 5 },

  // ── OpenRouter → Anthropic (same per-token prices as direct) ────────
  "anthropic/claude-opus-4.7": { input: 15, output: 75 },
  "anthropic/claude-opus-4.5": { input: 15, output: 75 },
  "anthropic/claude-opus-4": { input: 15, output: 75 },
  "anthropic/claude-sonnet-4.6": { input: 3, output: 15 },
  "anthropic/claude-sonnet-4.5": { input: 3, output: 15 },
  "anthropic/claude-sonnet-4": { input: 3, output: 15 },
  "anthropic/claude-haiku-4.5": { input: 1, output: 5 },

  // ── OpenRouter → OpenAI ─────────────────────────────────────────────
  // NOTE: As of 2026-04-22, `openai/gpt-5` on OpenRouter is priced
  // like gpt-4o (verified: $0.006831 reported for 41/678 tokens matches
  // $2.50 / $10 exactly). Either OpenRouter is aliasing gpt-5→gpt-4o or
  // GPT-5 actually ships at this price. Treat as gpt-4o until confirmed.
  "openai/gpt-5": { input: 2.5, output: 10 },
  "openai/gpt-5-mini": { input: 0.4, output: 1.6 },
  "openai/gpt-5-nano": { input: 0.1, output: 0.4 },
  "openai/gpt-4o": { input: 2.5, output: 10 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  // Reasoning models (o-series — expensive, use sparingly)
  "openai/o3": { input: 15, output: 60 },
  "openai/o3-mini": { input: 1.1, output: 4.4 },
  "openai/o4-mini": { input: 1.1, output: 4.4 },

  // ── OpenRouter → Google ─────────────────────────────────────────────
  // Gemini 2.5 Flash on OpenRouter: verified higher than Google direct.
  // Observed: $0.000033 for 27/10 tokens → back-computes to ~$0.50/$2.00.
  // Google direct is $0.075/$0.30 but OpenRouter applies a markup.
  "google/gemini-2.5-pro": { input: 1.25, output: 10 },
  "google/gemini-2.5-flash": { input: 0.5, output: 2 },
  "google/gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  // Legacy
  "google/gemini-2.0-pro": { input: 1.25, output: 5 },
  "google/gemini-2.0-flash": { input: 0.1, output: 0.4 },

  // ── OpenRouter → DeepSeek (very cheap, good for batch/data work) ────
  "deepseek/deepseek-v3": { input: 0.27, output: 1.1 },
  "deepseek/deepseek-r1": { input: 0.55, output: 2.19 },
  "deepseek/deepseek-chat": { input: 0.27, output: 1.1 },

  // ── OpenRouter → Meta Llama (open-weight, cheap) ────────────────────
  "meta-llama/llama-3.3-70b-instruct": { input: 0.23, output: 0.4 },
  "meta-llama/llama-3.1-405b-instruct": { input: 0.9, output: 0.9 },

  // ── OpenRouter → Mistral ────────────────────────────────────────────
  "mistralai/mistral-large": { input: 2, output: 6 },
  "mistralai/mixtral-8x22b-instruct": { input: 0.9, output: 0.9 },
};

export function priceFor(model: string): { input: number; output: number } {
  return MODEL_PRICING[model] ?? { input: 0, output: 0 };
}

export function computeCost(model: string, tokensIn: number, tokensOut: number): number {
  const p = priceFor(model);
  return (tokensIn * p.input + tokensOut * p.output) / 1_000_000;
}

export const AVAILABLE_MODELS = Object.keys(MODEL_PRICING);
