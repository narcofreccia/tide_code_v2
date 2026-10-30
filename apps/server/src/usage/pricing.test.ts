import { describe, expect, it } from "vitest";
import { estimate, normalizeModel, PRICING_VERSION, priceFor } from "./pricing.ts";

const M = 1_000_000;

describe("pricing", () => {
  it("prices a known model from its exact row", () => {
    expect(priceFor("claude-opus-5-5")?.basis).toBe("exact");
    expect(estimate("claude-opus-5-5", { in: M, out: M, cacheRead: M, cacheWrite: M })).toBeCloseTo(4 + 20 + 0.2 + 5);
  });

  it("falls back to the family by longest prefix", () => {
    expect(priceFor("claude-opus-5-5-20261001")?.basis).toBe("family");
    // a dated id of an older row keeps that row's price, not the newest family member's
    expect(estimate("claude-haiku-4-5-20251001", { in: M, out: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(1);
    expect(estimate("claude-sonnet-9", { in: M, out: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(2);
    // gpt-6.1-mini is not in the table: the gpt-6.1 family (longer than gpt-6) applies
    expect(estimate("gpt-6.1-mini", { in: M, out: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(2.5);
    expect(estimate("gpt-6-something", { in: M, out: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(1.25);
  });

  it("returns undefined for an unknown or missing model, never a guess", () => {
    expect(estimate("llama-99", { in: M, out: M, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
    expect(estimate(undefined, { in: M, out: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
  });

  it("prices OpenCode's free tier at zero", () => {
    expect(estimate("opencode/big-pickle", { in: M, out: M, cacheRead: 0, cacheWrite: 0 })).toBe(0);
  });

  it("strips provider prefixes and context suffixes", () => {
    expect(normalizeModel("anthropic/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(normalizeModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(normalizeModel("openai/GPT-6-luna")).toBe("gpt-6-luna");
    expect(priceFor("anthropic/claude-haiku-5-5")?.basis).toBe("exact");
  });

  it("has a version the page can show", () => {
    expect(PRICING_VERSION).toBe("2026-10");
  });
});
