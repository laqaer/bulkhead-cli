import { describe, it, expect } from "vitest";
import { usageCost, priceFor, DEFAULT_PRICING, FALLBACK_PRICE } from "../src/pricing.js";

describe("usageCost", () => {
  it("prices plain input/output tokens", () => {
    const price = { inputPerMTok: 5, outputPerMTok: 25 };
    // 1M input @ $5, 1M output @ $25
    expect(usageCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, price)).toBeCloseTo(30, 6);
  });

  it("prices cache reads at 0.1x input and writes at 1.25x input", () => {
    const price = { inputPerMTok: 10, outputPerMTok: 50 };
    // 1M cache read @ 0.1 * $10 = $1; 1M cache write @ 1.25 * $10 = $12.50
    const cost = usageCost(
      { cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 },
      price,
    );
    expect(cost).toBeCloseTo(13.5, 6);
  });

  it("treats missing fields as zero", () => {
    expect(usageCost({}, { inputPerMTok: 5, outputPerMTok: 25 })).toBe(0);
  });
});

describe("priceFor", () => {
  it("returns a known price exactly", () => {
    const { price, known } = priceFor("claude-opus-4-8");
    expect(known).toBe(true);
    expect(price).toEqual(DEFAULT_PRICING["claude-opus-4-8"]);
  });

  it("prefix-matches date-suffixed model ids", () => {
    const { price, known } = priceFor("claude-haiku-4-5-20251001");
    expect(known).toBe(true);
    expect(price).toEqual(DEFAULT_PRICING["claude-haiku-4-5"]);
  });

  it("falls back for unknown models (fails safe, non-zero)", () => {
    const { price, known } = priceFor("some-future-model");
    expect(known).toBe(false);
    expect(price).toEqual(FALLBACK_PRICE);
  });

  it("honors user overrides", () => {
    const { price, known } = priceFor("my-model", { "my-model": { inputPerMTok: 2, outputPerMTok: 8 } });
    expect(known).toBe(true);
    expect(price.inputPerMTok).toBe(2);
  });
});

describe("current models (September 2026)", () => {
  it("prices Opus 5.5 at $4/$20 with $0.20 cache reads", () => {
    const { price, known } = priceFor("claude-opus-5-5");
    expect(known).toBe(true);
    expect(usageCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, price)).toBeCloseTo(24, 6);
    expect(usageCost({ cache_read_input_tokens: 1_000_000 }, price)).toBeCloseTo(0.2, 6);
  });

  it("prices Fable 5.1 cache reads at $0.25, not 0.1x input", () => {
    const { price } = priceFor("claude-fable-5-1");
    expect(usageCost({ cache_read_input_tokens: 1_000_000 }, price)).toBeCloseTo(0.25, 6);
  });

  it("prices Sonnet 5 at $2/$10", () => {
    const { price } = priceFor("claude-sonnet-5");
    expect(usageCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, price)).toBeCloseTo(12, 6);
  });

  it("resolves a date-suffixed id to the LONGEST matching prefix", () => {
    expect(priceFor("claude-opus-5-5-20260901").price).toEqual(DEFAULT_PRICING["claude-opus-5-5"]);
    expect(priceFor("claude-opus-5-20260401").price).toEqual(DEFAULT_PRICING["claude-opus-5"]);
    expect(priceFor("claude-fable-5-1-20260801").price).toEqual(DEFAULT_PRICING["claude-fable-5-1"]);
  });

  it("keeps the 0.1x default for models without a cache-read override", () => {
    const { price } = priceFor("claude-opus-4-8");
    expect(usageCost({ cache_read_input_tokens: 1_000_000 }, price)).toBeCloseTo(0.5, 6);
  });
});
