import { describe, expect, it } from "vitest";
import { nextFireAt } from "./schedule.ts";

// local-time constructors keep these independent of the machine's zone
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
// 2026-10-16 is a Friday; 2026-10-19 a Monday
const weekdays = [1, 2, 3, 4, 5];

describe("nextFireAt", () => {
  it("interval: now + everyMs", () => {
    expect(nextFireAt({ kind: "interval", everyMs: 90_000 }, 1000)).toBe(91_000);
  });

  it("fixed: later today, else the next time slot", () => {
    const s = { kind: "fixed" as const, times: ["18:00", "09:00"], weekdays };
    expect(nextFireAt(s, at(2026, 10, 14, 8, 0))).toBe(at(2026, 10, 14, 9, 0));
    expect(nextFireAt(s, at(2026, 10, 14, 9, 0))).toBe(at(2026, 10, 14, 18, 0));
    expect(nextFireAt(s, at(2026, 10, 14, 19, 0))).toBe(at(2026, 10, 15, 9, 0));
  });

  it("fixed: skips the weekend", () => {
    const s = { kind: "fixed" as const, times: ["09:00"], weekdays };
    expect(nextFireAt(s, at(2026, 10, 16, 10, 0))).toBe(at(2026, 10, 19, 9, 0));
    expect(nextFireAt(s, at(2026, 10, 17, 12, 0))).toBe(at(2026, 10, 19, 9, 0));
  });

  it("fixed: a single weekday rolls a full week", () => {
    const s = { kind: "fixed" as const, times: ["09:00"], weekdays: [5] };
    expect(nextFireAt(s, at(2026, 10, 16, 9, 0))).toBe(at(2026, 10, 23, 9, 0));
  });

  it("once: the stored time, future or already past (a missed slot still fires on the next tick)", () => {
    expect(nextFireAt({ kind: "once", at: at(2026, 11, 6, 14, 30) }, at(2026, 11, 4, 9, 0))).toBe(at(2026, 11, 6, 14, 30));
    expect(nextFireAt({ kind: "once", at: at(2026, 11, 1, 8, 0) }, at(2026, 11, 4, 9, 0))).toBe(at(2026, 11, 1, 8, 0));
  });
});
