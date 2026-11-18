import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent, RateLimit } from "@tide/contracts";
import { ClaudeNormalizer } from "../src/normalize.ts";
import type { ClaudeMessage } from "../src/sdk-shapes.ts";

const frame = (info: Record<string, unknown>) => ({ type: "rate_limit_event", rate_limit_info: info }) as ClaudeMessage;
const limits = (events: NormalizedEvent[]): RateLimit[] => events.flatMap((e) => (e.type === "usage" && e.rateLimit ? [e.rateLimit] : []));
const infos = (events: NormalizedEvent[]): string[] => events.flatMap((e) => (e.type === "activity" && e.activity.kind === "info" ? [e.activity.text] : []));

describe("rate_limit_event: one report per window", () => {
  it("recorded frame: the weekly window first, the frame's own five-hour window last", () => {
    const line = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "basic-turn.ndjson"), "utf8").split("\n")[5]!;
    const n = new ClaudeNormalizer({ partialMessages: true, now: () => 42 });
    const events = n.next(JSON.parse(line) as ClaudeMessage);
    expect(limits(events)).toEqual([
      { status: "ok", remainingPct: 91, resetsAt: 1792407600000, note: "seven_day 9% used", window: "weekly", windowMins: 10080, at: 42 },
      { status: "ok", remainingPct: 82, resetsAt: 1791850200000, overage: false, note: "five_hour 18% used", window: "session", windowMins: 300, at: 42 },
    ]);
    // a nominal frame earns no timeline row
    expect(infos(events)).toEqual([]);
  });

  it("a non-binding window turns to warning from its own utilization, never limited", () => {
    const n = new ClaudeNormalizer({ partialMessages: true, now: () => 1 });
    const events = n.next(frame({ status: "allowed", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.2 }, seven_day: { utilization: 1 } } }));
    expect(limits(events).map((l) => [l.window, l.status])).toEqual([
      ["weekly", "warning"],
      ["session", "ok"],
    ]);
  });

  it("a rejection of the weekly window: the binding report is limited, the session window keeps its own status", () => {
    const n = new ClaudeNormalizer({ partialMessages: true, now: () => 1 });
    const events = n.next(frame({ status: "rejected", rateLimitType: "seven_day", resetsAt: 900, unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 100 }, seven_day: { utilization: 1, resetsAt: 900 } } }));
    expect(limits(events)).toEqual([
      { status: "ok", remainingPct: 60, resetsAt: 100_000, note: "five_hour 40% used", window: "session", windowMins: 300, at: 1 },
      { status: "limited", remainingPct: 0, resetsAt: 900_000, note: "seven_day 100% used (rejected)", window: "weekly", windowMins: 10080, at: 1 },
    ]);
    expect(infos(events)).toEqual(["Rate limit rejected on seven_day (100% used)"]);
  });

  it("an overage rejection is a warning on a report with no window, after the plan windows", () => {
    const n = new ClaudeNormalizer({ partialMessages: true, now: () => 1 });
    const events = n.next(
      frame({ status: "rejected", rateLimitType: "seven_day_overage_included", isUsingOverage: false, resetsAt: 1788141000, unifiedWindows: { five_hour: { utilization: 0.1 }, seven_day: { utilization: 0.5 }, seven_day_overage_included: { utilization: 1 } } }),
    );
    const reports = limits(events);
    expect(reports.map((l) => l.window)).toEqual(["session", "weekly", undefined]);
    expect(reports.at(-1)).toEqual({ status: "warning", remainingPct: 0, resetsAt: 1788141000000, overage: false, note: "seven_day_overage_included 100% used (rejected)", at: 1 });
    expect(limits(n.next(frame({ status: "rejected", rateLimitType: "overage" })))).toEqual([{ status: "warning", note: "overage (rejected)", at: 1 }]);
  });

  it("a per-model window frame keeps its note and names no window", () => {
    const n = new ClaudeNormalizer({ partialMessages: true, now: () => 1 });
    const reports = limits(n.next(frame({ status: "allowed_warning", rateLimitType: "seven_day_opus", unifiedWindows: { seven_day_opus: { utilization: 0.92 } } })));
    expect(reports).toEqual([{ status: "warning", remainingPct: 8, note: "seven_day_opus 92% used", at: 1 }]);
  });

  it("without unifiedWindows: one report as before, with the window when the type names one", () => {
    const n = new ClaudeNormalizer({ partialMessages: true, now: () => 1 });
    const warn = n.next(frame({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9, isUsingOverage: true }));
    expect(limits(warn)).toEqual([{ status: "warning", remainingPct: 10, overage: true, note: "seven_day 90% used", window: "weekly", windowMins: 10080, at: 1 }]);
    expect(infos(warn)).toEqual(["Rate limit allowed_warning on seven_day (90% used)"]);
    expect(limits(n.next(frame({ status: "rejected" })))).toEqual([{ status: "limited", note: "rate limit (rejected)", at: 1 }]);
    expect(limits(n.next(frame({ status: "rejected", rateLimitType: "five_hour" })))).toMatchObject([{ status: "limited", window: "session" }]);
    expect(n.next(frame({}))).toEqual([]);
  });
});
