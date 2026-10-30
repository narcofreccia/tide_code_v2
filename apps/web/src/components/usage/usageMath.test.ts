import { describe, expect, it } from "vitest";
import type { UsageRow } from "@tide/contracts";
import { barStep, groupByHarness, sumRows, windowRange, DAY_MS } from "./usageMath.ts";

const row = (patch: Partial<UsageRow>): UsageRow => ({
  provider: "claude",
  source: "tide",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  turns: 0,
  ...patch,
});

describe("usage math", () => {
  it("sums tokens and keeps reported and estimated cost apart", () => {
    const t = sumRows([
      row({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1, turns: 2, costUsd: 0.5 }),
      row({ inputTokens: 1, outputTokens: 1, turns: 1, estimatedUsd: 0.25 }),
    ]);
    expect(t).toEqual({ inputTokens: 11, outputTokens: 6, cacheReadTokens: 100, cacheWriteTokens: 1, turns: 3, costUsd: 0.5, estimatedUsd: 0.25 });
    expect(sumRows([row({})]).costUsd).toBeUndefined();
  });

  it("groups by harness instance, heaviest first", () => {
    const groups = groupByHarness([
      row({ provider: "codex", model: "gpt-5", inputTokens: 5 }),
      row({ model: "opus", inputTokens: 50 }),
      row({ model: "sonnet", inputTokens: 80, source: "external" }),
      row({ provider: "codex", providerId: "codex:work", inputTokens: 1 }),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["claude", "codex", "codex:work"]);
    expect(groups[0]?.rows.map((r) => r.model)).toEqual(["sonnet", "opus"]);
    expect(groups[0]?.totals.inputTokens).toBe(130);
  });

  it("maps values onto the 0..20 bar scale", () => {
    expect(barStep(0, 100)).toBe(0);
    expect(barStep(1, 1000)).toBe(1);
    expect(barStep(50, 100)).toBe(10);
    expect(barStep(100, 100)).toBe(20);
    expect(barStep(5, 0)).toBe(0);
  });

  it("computes preset and custom windows", () => {
    expect(windowRange(7, 10 * DAY_MS)).toEqual({ since: 3 * DAY_MS, until: 10 * DAY_MS });
    const custom = windowRange("custom", 0, { from: "2026-10-01", to: "2026-10-02" });
    expect(custom.until - custom.since).toBe(2 * DAY_MS - 1);
    // an inverted range falls back to the last 7 days
    expect(windowRange("custom", 10 * DAY_MS, { from: "2026-10-05", to: "2026-10-01" })).toEqual({ since: 3 * DAY_MS, until: 10 * DAY_MS });
  });
});
