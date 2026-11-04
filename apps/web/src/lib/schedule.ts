import type { Schedule } from "@tide/contracts";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Monday first; 0 is Sunday (JS `getDay`). */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const weekdayName = (day: number): string => DAYS[day] ?? String(day);

function days(weekdays: readonly number[]): string {
  const set = new Set(weekdays);
  if (set.size === 7) return "every day";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return "Mon–Fri";
  if (set.size === 2 && set.has(0) && set.has(6)) return "Sat–Sun";
  return WEEKDAY_ORDER.filter((d) => set.has(d)).map(weekdayName).join(", ");
}

/** "every 30 min", "every 2 h", "Mon–Fri at 09:00", "every day at 09:00, 17:30". */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "webhook") return `on webhook /hook/${schedule.hookId}`;
  if (schedule.kind === "interval") {
    const mins = Math.round(schedule.everyMs / 60_000);
    if (mins >= 60 && mins % 60 === 0) return `every ${mins / 60 === 1 ? "hour" : `${mins / 60} h`}`;
    return `every ${mins} min`;
  }
  if (schedule.kind === "once") return `once on ${new Date(schedule.at).toLocaleString()}`;
  const times = [...schedule.times].sort().join(", ");
  const d = days(schedule.weekdays);
  return d === "every day" ? `every day at ${times}` : `${d} at ${times}`;
}
