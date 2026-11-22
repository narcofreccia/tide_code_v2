import type { ProviderKind, ProviderStatusDto, RateLimit, ReadModel } from "@tide/contracts";
import { instanceLabel, isProviderKind } from "./vocab.ts";

/** The subscription windows harnesses report: Claude's five_hour / seven_day, Codex's primary / secondary. */
export type LimitWindow = "5h" | "wk" | "other";

export const WINDOW_LABELS: Record<LimitWindow, string> = { "5h": "5h", wk: "wk", other: "limit" };

/** R20: the server's window names. */
const FROM_MODEL: Record<NonNullable<RateLimit["window"]>, LimitWindow> = { session: "5h", weekly: "wk" };

/**
 * Which window a report is about: the server's `window` when it names one. The drivers keep the harness's own wording in
 * `note` (`five_hour 38% used`, `codex 12% used (5h window)`), so this reads it;
 * a report that names no window, or an overage window, is `other`.
 */
export function limitWindow(limit: RateLimit): LimitWindow {
  if (limit.window !== undefined) return FROM_MODEL[limit.window];
  const note = (limit.note ?? "").toLowerCase();
  // extra usage beyond the plan (`seven_day_overage_included`): not the plan's weekly window
  if (note.includes("overage")) return "other";
  if (/five_hour|5h window|\b5 ?h\b|primary/.test(note)) return "5h";
  if (/seven_day|week|\b168h window|\b7d\b|secondary/.test(note)) return "wk";
  return "other";
}

/** Share of the window used, 0..100; undefined when the harness gave no number. */
export function usedPct(limit: RateLimit): number | undefined {
  return limit.remainingPct === undefined ? undefined : Math.max(0, Math.min(100, 100 - limit.remainingPct));
}

export interface InstanceLimits {
  /** instance id (`claude`, `codex:work`) */
  id: string;
  provider: ProviderKind;
  /** the latest report per window */
  windows: Partial<Record<LimitWindow, RateLimit>>;
}

/** `codex:work` -> `codex`; an id that names no kind falls back to a thread on that instance. */
function providerOf(model: Pick<ReadModel, "threads">, id: string): ProviderKind | undefined {
  const kind = id.split(":")[0] ?? id;
  if (isProviderKind(kind)) return kind;
  return Object.values(model.threads).find((t) => (t.providerId ?? t.provider) === id)?.provider;
}

/**
 * True when a `thread.rateLimit` should not be attributed to `provider` — either because it is
 * a stale Claude/Codex limit left behind after switching harnesses, or its reset time already passed.
 */
export function isStaleThreadRateLimit(provider: ProviderKind, limit: RateLimit, now = Date.now()): boolean {
  if (limit.resetsAt !== undefined && limit.resetsAt <= now) return true;
  const note = (limit.note ?? "").toLowerCase();
  if (note === "") return false;
  if (provider !== "claude" && /\b(?:five_hour|seven_day)\b/.test(note)) return true;
  if (provider !== "codex" && /\bcodex\b.*\bwindow\b/.test(note)) return true;
  return false;
}

/**
 * The latest rate-limit report per harness instance and window. The subscription is shared by
 * every thread on an instance, so the newest report for a window is the current one, whichever
 * thread carried it. R20 servers keep the windowed reports in `model.limits`; a report that names
 * no window (an overage window), and every report from an older server, is read from the threads,
 * its window guessed from the harness's note.
 */
export function selectInstanceLimits(model: Pick<ReadModel, "threads" | "limits">, now = Date.now()): InstanceLimits[] {
  const byId = new Map<string, InstanceLimits>();
  const put = (id: string, provider: ProviderKind, window: LimitWindow, limit: RateLimit): void => {
    const entry = byId.get(id) ?? { id, provider, windows: {} };
    const previous = entry.windows[window];
    if (!previous || limit.at > previous.at) entry.windows[window] = limit;
    byId.set(id, entry);
  };
  const structured = model.limits !== undefined;
  for (const thread of Object.values(model.threads)) {
    const limit = thread.rateLimit;
    if (thread.archivedAt !== undefined || !limit) continue;
    if (structured && limit.window !== undefined) continue;
    if (isStaleThreadRateLimit(thread.provider, limit, now)) continue;
    put(thread.providerId ?? thread.provider, thread.provider, limitWindow(limit), limit);
  }
  for (const [id, windows] of Object.entries(model.limits ?? {})) {
    const provider = providerOf(model, id);
    if (provider === undefined) continue;
    for (const [window, limit] of Object.entries(windows)) {
      const key = FROM_MODEL[window as keyof typeof FROM_MODEL];
      if (key !== undefined && limit !== undefined) put(id, provider, key, limit);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The highest used share across an instance's windows; -1 when none reported a number. */
export function tightness(entry: InstanceLimits): number {
  let worst = -1;
  for (const limit of Object.values(entry.windows)) {
    if (!limit) continue;
    if (limit.status === "limited") return 101;
    worst = Math.max(worst, usedPct(limit) ?? -1);
  }
  return worst;
}

const SHORT: Record<ProviderKind, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", pi: "Pi", antigravity: "Antigravity", acp: "ACP" };

/** `Claude`, `Codex · work`: short enough for the status bar. */
export function shortInstanceLabel(providers: readonly ProviderStatusDto[], id: string): string {
  return isProviderKind(id) ? SHORT[id] : instanceLabel(providers, id);
}

const ORDER: LimitWindow[] = ["5h", "wk", "other"];

/** `5h 62% · wk 18%`: used share per window, in a fixed order. */
export function windowsText(entry: InstanceLimits): string {
  return ORDER.flatMap((window) => {
    const limit = entry.windows[window];
    if (!limit) return [];
    if (limit.status === "limited") return [`${WINDOW_LABELS[window]} limited`];
    const used = usedPct(limit);
    return used === undefined ? [] : [`${WINDOW_LABELS[window]} ${Math.round(used)}%`];
  }).join(" · ");
}

/** The instance closest to its limit, or undefined when nothing reported a usable number. */
export function tightestInstance(model: Pick<ReadModel, "threads" | "limits">): InstanceLimits | undefined {
  let best: InstanceLimits | undefined;
  let bestScore = -1;
  for (const entry of selectInstanceLimits(model)) {
    const score = tightness(entry);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return bestScore < 0 ? undefined : best;
}

export const LIMIT_WINDOWS = ORDER;
