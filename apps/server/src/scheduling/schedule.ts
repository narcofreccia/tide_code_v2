import type { Schedule } from "@tide/contracts";

const DAY_LOOKAHEAD = 8;

/**
 * The next instant strictly after `now` the schedule fires. Interval: `now + everyMs`.
 * Fixed: the next matching weekday/time in the server's local time zone (DST-safe: each
 * candidate is built from local calendar fields). Returns undefined only for an empty schedule.
 */
export function nextFireAt(schedule: Schedule, now: number): number | undefined {
  if (schedule.kind === "webhook") return undefined; // fired by POST /hook/<id>, never by the clock
  if (schedule.kind === "interval") return now + schedule.everyMs;
  const times = [...new Set(schedule.times)].sort().map((t) => {
    const [h, m] = t.split(":");
    return { h: Number(h), m: Number(m) };
  });
  const days = new Set(schedule.weekdays);
  const base = new Date(now);
  for (let i = 0; i < DAY_LOOKAHEAD; i++) {
    for (const { h, m } of times) {
      const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, h, m, 0, 0);
      if (!days.has(candidate.getDay())) continue;
      if (candidate.getTime() > now) return candidate.getTime();
    }
  }
  return undefined;
}
