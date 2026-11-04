/** Snooze choices are strings the user edits in Settings › Inbox: a duration or a time on a day. */
export const DEFAULT_SNOOZE_OPTIONS: readonly string[] = ["1h", "tomorrow 09:00"];

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DURATION = /^(\d+)([mhd])$/;
const AT = /^(mon|tue|wed|thu|fri|sat|sun|tomorrow) ([01]\d|2[0-3]):([0-5]\d)$/;

export type SnoozeOption =
  | { kind: "duration"; ms: number }
  | { kind: "at"; day: "tomorrow" | 0 | 1 | 2 | 3 | 4 | 5 | 6; hh: number; mm: number };

/** `2h`, `45m`, `1d`, `tomorrow 09:00`, `fri 18:00` (case-insensitive); undefined when it is none of those. */
export function parseSnoozeOption(text: string): SnoozeOption | undefined {
  const s = text.trim().toLowerCase();
  const dur = DURATION.exec(s);
  if (dur) {
    const n = Number(dur[1]);
    return n > 0 ? { kind: "duration", ms: n * UNIT_MS[dur[2] as keyof typeof UNIT_MS] } : undefined;
  }
  const at = AT.exec(s);
  if (!at) return undefined;
  const word = at[1] as string;
  const day = word === "tomorrow" ? "tomorrow" : (WEEKDAYS.indexOf(word as (typeof WEEKDAYS)[number]) as 0 | 1 | 2 | 3 | 4 | 5 | 6);
  return { kind: "at", day, hh: Number(at[2]), mm: Number(at[3]) };
}

/** The instant an option resolves to. A weekday is its next occurrence strictly after `now`. */
export function snoozeUntil(option: SnoozeOption, now: number): number {
  if (option.kind === "duration") return now + option.ms;
  const base = new Date(now);
  const at = (offset: number): number => new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, option.hh, option.mm, 0, 0).getTime();
  if (option.day === "tomorrow") return at(1);
  const ahead = (option.day - base.getDay() + 7) % 7;
  const today = at(ahead);
  return today > now ? today : at(ahead + 7);
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "2 h", "45 min", "Tomorrow 09:00", "Fri 18:00". */
export function snoozeLabel(option: SnoozeOption): string {
  if (option.kind === "at") {
    const day = option.day === "tomorrow" ? "Tomorrow" : (WEEKDAYS[option.day] as string).replace(/^./, (c) => c.toUpperCase());
    return `${day} ${pad(option.hh)}:${pad(option.mm)}`;
  }
  const { ms } = option;
  if (ms % UNIT_MS.d === 0) return `${ms / UNIT_MS.d} d`;
  if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h} h`;
  return `${ms / UNIT_MS.m} min`;
}

export interface ResolvedSnooze {
  label: string;
  /** the instant, computed when asked so a menu left open does not go stale */
  until: (now?: number) => number;
}

/** The configured options that parse, in order; an empty or unusable list falls back to the defaults. */
export function resolveSnoozeOptions(options: readonly string[] | undefined): ResolvedSnooze[] {
  const parse = (list: readonly string[]): ResolvedSnooze[] =>
    list.flatMap((text) => {
      const option = parseSnoozeOption(text);
      return option ? [{ label: snoozeLabel(option), until: (now: number = Date.now()) => snoozeUntil(option, now) }] : [];
    });
  const resolved = parse(options ?? DEFAULT_SNOOZE_OPTIONS);
  return resolved.length > 0 ? resolved : parse(DEFAULT_SNOOZE_OPTIONS);
}

/** Comma-separated field → a problem message, or undefined when every entry parses (and there are ≤ 8). */
export function snoozeFieldProblem(text: string): string | undefined {
  const entries = splitSnoozeField(text);
  if (entries.length > 8) return "At most 8 options.";
  const bad = entries.find((e) => parseSnoozeOption(e) === undefined);
  return bad === undefined ? undefined : `“${bad}” is not a duration (2h, 45m, 1d) or a time (tomorrow 09:00, fri 18:00).`;
}

export const splitSnoozeField = (text: string): string[] => text.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== "");
