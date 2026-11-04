import { describe, expect, it } from "vitest";
import { describeSchedule, formatOnce } from "./schedule.ts";

const at = (y: number, mo: number, d: number, h: number, mi: number): number => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 4, 10, 0);

describe("describeSchedule", () => {
  it("words a one-time schedule", () => {
    expect(describeSchedule({ kind: "once", at: at(2026, 11, 6, 14, 30) }, NOW)).toBe("once on 6 Nov, 14:30");
    expect(describeSchedule({ kind: "once", at: at(2027, 1, 2, 9, 5) }, NOW)).toBe("once on 2 Jan 2027, 09:05");
    expect(formatOnce(at(2026, 12, 31, 23, 59), NOW)).toBe("31 Dec, 23:59");
  });

  it("keeps the other kinds", () => {
    expect(describeSchedule({ kind: "interval", everyMs: 7_200_000 })).toBe("every 2 h");
    expect(describeSchedule({ kind: "fixed", times: ["09:00"], weekdays: [1, 2, 3, 4, 5] })).toBe("Mon–Fri at 09:00");
  });
});
