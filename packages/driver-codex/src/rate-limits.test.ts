import { describe, expect, it } from "vitest";
import type { RateLimitSnapshot } from "./generated/v2/RateLimitSnapshot.ts";
import { rateLimitsFromSnapshot } from "./rate-limits.ts";

const snapshot = (fields: Partial<RateLimitSnapshot>): RateLimitSnapshot => ({
  limitId: "codex",
  limitName: null,
  normalModelSlug: null,
  primary: null,
  secondary: null,
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  planType: null,
  rateLimitReachedType: null,
  ...fields,
});

describe("rateLimitsFromSnapshot", () => {
  it("reports each window, classified by length, the tighter one last", () => {
    const limits = rateLimitsFromSnapshot(snapshot({ primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 100 }, secondary: { usedPercent: 92, windowDurationMins: 10080, resetsAt: 200 } }), 5);
    expect(limits).toEqual([
      { status: "ok", remainingPct: 70, resetsAt: 100_000, note: "codex 30% used (5h window)", window: "session", windowMins: 300, at: 5 },
      { status: "warning", remainingPct: 8, resetsAt: 200_000, note: "codex 92% used (168h window)", window: "weekly", windowMins: 10080, at: 5 },
    ]);
  });

  it("a reached limit lands on the binding window; a full non-binding window is limited on its own", () => {
    const limits = rateLimitsFromSnapshot(snapshot({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null }, rateLimitReachedType: "rate_limit_reached" }), 1);
    expect(limits.map((l) => [l.window, l.status, l.note])).toEqual([
      ["weekly", "ok", "codex 40% used (168h window)"],
      ["session", "limited", "codex: rate limit reached"],
    ]);
  });

  it("a recorded free-plan snapshot: one 30-day window (epoch seconds), filed as the long window", () => {
    // from a codex rollout: "primary":{"used_percent":7.0,"window_minutes":43200,"resets_at":1794660275}
    const [limit] = rateLimitsFromSnapshot(snapshot({ primary: { usedPercent: 7, windowDurationMins: 43200, resetsAt: 1794660275 } }), 1);
    expect(limit).toMatchObject({ status: "ok", window: "weekly", windowMins: 43200, resetsAt: 1794660275000 });
  });

  it("no window: nothing, unless a limit was reached; an unknown length names no window", () => {
    expect(rateLimitsFromSnapshot(null, 1)).toEqual([]);
    expect(rateLimitsFromSnapshot(snapshot({}), 1)).toEqual([]);
    expect(rateLimitsFromSnapshot(snapshot({ spendControlReached: true }), 1)).toEqual([{ status: "limited", at: 1 }]);
    const [unknown] = rateLimitsFromSnapshot(snapshot({ primary: { usedPercent: 10, windowDurationMins: null, resetsAt: null } }), 1);
    expect(unknown).toEqual({ status: "ok", remainingPct: 90, note: "codex 10% used", at: 1 });
  });
});
