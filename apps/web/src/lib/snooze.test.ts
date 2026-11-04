import { describe, expect, it } from "vitest";
import { parseSnoozeOption, resolveSnoozeOptions, snoozeFieldProblem, snoozeLabel, snoozeUntil } from "./snooze.ts";

// Wed 4 Nov 2026, 10:00 local
const NOW = new Date(2026, 10, 4, 10, 0, 0, 0).getTime();
const at = (d: number, h: number, m = 0): number => new Date(2026, 10, d, h, m, 0, 0).getTime();
const until = (text: string, now = NOW): number | undefined => {
  const o = parseSnoozeOption(text);
  return o === undefined ? undefined : snoozeUntil(o, now);
};

describe("snooze options", () => {
  it("parses durations and times on a day, case-insensitively", () => {
    expect(parseSnoozeOption("2h")).toEqual({ kind: "duration", ms: 7_200_000 });
    expect(parseSnoozeOption("45M")).toEqual({ kind: "duration", ms: 2_700_000 });
    expect(parseSnoozeOption("Tomorrow 09:00")).toEqual({ kind: "at", day: "tomorrow", hh: 9, mm: 0 });
    expect(parseSnoozeOption("FRI 18:30")).toEqual({ kind: "at", day: 5, hh: 18, mm: 30 });
    expect(parseSnoozeOption("sun 00:00")).toEqual({ kind: "at", day: 0, hh: 0, mm: 0 });
  });

  it.each(["", "h", "2", "2x", "1.5h", "0h", "tomorrow", "tomorrow 9:00", "fri 24:00", "fri 18:60", "someday 09:00", "2h 3m"])("rejects %j", (text) => {
    expect(parseSnoozeOption(text)).toBeUndefined();
  });

  it("resolves durations from now", () => {
    expect(until("2h")).toBe(NOW + 7_200_000);
    expect(until("1d")).toBe(NOW + 86_400_000);
  });

  it("resolves tomorrow to the next calendar day", () => {
    expect(until("tomorrow 09:00")).toBe(at(5, 9));
    expect(until("tomorrow 23:59", at(30, 23, 59))).toBe(new Date(2026, 11, 1, 23, 59).getTime());
  });

  it("resolves a weekday to its next occurrence strictly after now", () => {
    expect(until("fri 18:00")).toBe(at(6, 18));
    expect(until("wed 18:00")).toBe(at(4, 18)); // later today
    expect(until("wed 09:00")).toBe(at(11, 9)); // today's time passed: next week
    expect(until("wed 10:00")).toBe(at(11, 10)); // exactly now is not after now
    expect(until("tue 09:00")).toBe(at(10, 9)); // wraps past Sunday
    expect(until("sun 08:00")).toBe(at(8, 8));
  });

  it("labels", () => {
    const label = (t: string): string => snoozeLabel(parseSnoozeOption(t)!);
    expect(label("2h")).toBe("2 h");
    expect(label("45m")).toBe("45 min");
    expect(label("60m")).toBe("1 h");
    expect(label("2d")).toBe("2 d");
    expect(label("tomorrow 09:00")).toBe("Tomorrow 09:00");
    expect(label("fri 18:00")).toBe("Fri 18:00");
  });

  it("resolves a list, skipping bad entries and falling back to the defaults", () => {
    expect(resolveSnoozeOptions(["3h", "bad", "mon 08:00"]).map((o) => o.label)).toEqual(["3 h", "Mon 08:00"]);
    expect(resolveSnoozeOptions(undefined).map((o) => o.label)).toEqual(["1 h", "Tomorrow 09:00"]);
    expect(resolveSnoozeOptions(["bad"]).map((o) => o.label)).toEqual(["1 h", "Tomorrow 09:00"]);
    expect(resolveSnoozeOptions(["2h"])[0]?.until(NOW)).toBe(NOW + 7_200_000);
  });

  it("explains a bad field", () => {
    expect(snoozeFieldProblem("1h, fri 18:00")).toBeUndefined();
    expect(snoozeFieldProblem("1h, soon")).toMatch(/“soon”/);
    expect(snoozeFieldProblem("1h,2h,3h,4h,5h,6h,7h,8h,9h")).toMatch(/At most 8/);
  });
});
