import { describe, expect, it } from "vitest";
import type { RateLimit } from "@tide/contracts";
import { isRedundantGauge } from "./gauges.ts";

const stored: RateLimit = { status: "ok", window: "session", remainingPct: 80.2, resetsAt: 9_000, at: 1 };

describe("isRedundantGauge", () => {
  it("drops a windowed report that says nothing new (remaining share compared rounded, `at` ignored)", () => {
    expect(isRedundantGauge({ rateLimit: { ...stored, remainingPct: 79.6, at: 2 } }, stored)).toBe(true);
  });

  it("keeps a report whose status, share, reset or overage moved", () => {
    expect(isRedundantGauge({ rateLimit: { ...stored, status: "warning" } }, stored)).toBe(false);
    expect(isRedundantGauge({ rateLimit: { ...stored, remainingPct: 70 } }, stored)).toBe(false);
    expect(isRedundantGauge({ rateLimit: { ...stored, resetsAt: 9_001 } }, stored)).toBe(false);
    expect(isRedundantGauge({ rateLimit: { ...stored, overage: true } }, stored)).toBe(false);
  });

  it("keeps the first limited report", () => {
    expect(isRedundantGauge({ rateLimit: { ...stored, status: "limited" } }, stored)).toBe(false);
  });

  it("keeps everything that is not a bare windowed gauge, and anything with nothing stored", () => {
    expect(isRedundantGauge({ rateLimit: stored }, undefined)).toBe(false);
    expect(isRedundantGauge({ rateLimit: stored, usage: { inputTokens: 1, outputTokens: 1 } }, stored)).toBe(false);
    expect(isRedundantGauge({ rateLimit: stored, contextUsage: { used: 1, window: 10 } }, stored)).toBe(false);
    const { window: _window, ...windowless } = stored;
    expect(isRedundantGauge({ rateLimit: windowless }, stored)).toBe(false);
    expect(isRedundantGauge({}, stored)).toBe(false);
  });
});
