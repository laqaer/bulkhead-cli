import type { ModelPrice, Usage } from "./types.js";

/**
 * Per-1M-token list prices (USD), current as of July 2026.
 * Source: Anthropic model pricing. Kept deliberately small — this is used only
 * to turn transcript token counts into a dollar estimate for the budget guard,
 * not to bill anyone. Users can override or extend via `budget.pricing` in
 * bulkhead.yaml for models not listed here.
 */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-mythos-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * When a transcript references a model we don't have a price for, we still want
 * a non-zero estimate so the budget guard fails safe (over-counts rather than
 * under-counts). Opus-tier rates are the conservative choice.
 */
export const FALLBACK_PRICE: ModelPrice = { inputPerMTok: 5, outputPerMTok: 25 };

/**
 * Cache multipliers relative to the base input rate. 5-minute cache writes cost
 * 1.25× input; 1-hour writes cost 2×; cache reads cost ~0.1×. When the
 * transcript gives no TTL breakdown we assume the 5-minute default (1.25×).
 */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;
export const CACHE_READ_MULTIPLIER = 0.1;

const PER_TOKEN = 1_000_000;

/**
 * Cost of a single assistant message's usage, in USD. Pure function of usage +
 * price so it is trivially testable and reproducible. Uses the per-TTL cache
 * breakdown when the transcript provides it, else prices all cache-creation
 * tokens at the 5-minute rate.
 */
export function usageCost(usage: Usage, price: ModelPrice): number {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  const inRate = price.inputPerMTok / PER_TOKEN;
  const outRate = price.outputPerMTok / PER_TOKEN;

  const cacheWriteCost = cacheCreationCost(usage, inRate);

  return (
    input * inRate +
    output * outRate +
    cacheWriteCost +
    cacheRead * inRate * CACHE_READ_MULTIPLIER
  );
}

function cacheCreationCost(usage: Usage, inRate: number): number {
  const breakdown = usage.cache_creation;
  if (breakdown && (breakdown.ephemeral_5m_input_tokens != null || breakdown.ephemeral_1h_input_tokens != null)) {
    const t5 = breakdown.ephemeral_5m_input_tokens ?? 0;
    const t1h = breakdown.ephemeral_1h_input_tokens ?? 0;
    return t5 * inRate * CACHE_WRITE_5M_MULTIPLIER + t1h * inRate * CACHE_WRITE_1H_MULTIPLIER;
  }
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return cacheWrite * inRate * CACHE_WRITE_5M_MULTIPLIER;
}

export function priceFor(
  model: string | undefined,
  overrides?: Record<string, ModelPrice>,
): { price: ModelPrice; known: boolean } {
  if (!model) return { price: FALLBACK_PRICE, known: false };
  const merged = { ...DEFAULT_PRICING, ...(overrides ?? {}) };
  const hit = merged[model];
  if (hit) return { price: hit, known: true };
  // Prefix match handles date-suffixed ids like claude-haiku-4-5-20251001.
  for (const [id, price] of Object.entries(merged)) {
    if (model.startsWith(id)) return { price, known: true };
  }
  return { price: FALLBACK_PRICE, known: false };
}
