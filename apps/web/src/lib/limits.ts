import type { ProviderKind, ProviderStatusDto, RateLimit, ReadModel } from "@tide/contracts";
import { instanceLabel, isProviderKind } from "./vocab.ts";

/** The subscription windows harnesses report: Claude's five_hour / seven_day, Codex's primary / secondary. */
export type LimitWindow = "5h" | "wk" | "other";

export const WINDOW_LABELS: Record<LimitWindow, string> = { "5h": "5h", wk: "wk", other: "limit" };

/**
 * Which window a report is about. The drivers keep the harness's own wording in
 * `note` (`five_hour 38% used`, `codex 12% used (5h window)`), so this reads it;
 * a report that names no window is `other`.
 */
export function limitWindow(limit: RateLimit): LimitWindow {
  const note = (limit.note ?? "").toLowerCase();
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

/**
 * The latest rate-limit report per harness instance and window, across live threads.
 * The subscription is shared by every thread on an instance, so the newest report
 * for a window is the current one, whichever thread carried it.
 */
export function selectInstanceLimits(model: ReadModel): InstanceLimits[] {
  const byId = new Map<string, InstanceLimits>();
  for (const thread of Object.values(model.threads)) {
    const limit = thread.rateLimit;
    if (thread.archivedAt !== undefined || !limit) continue;
    const id = thread.providerId ?? thread.provider;
    const entry = byId.get(id) ?? { id, provider: thread.provider, windows: {} };
    const window = limitWindow(limit);
    const previous = entry.windows[window];
    if (!previous || limit.at > previous.at) entry.windows[window] = limit;
    byId.set(id, entry);
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

const SHORT: Record<ProviderKind, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", pi: "Pi", acp: "ACP" };

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
export function tightestInstance(model: ReadModel): InstanceLimits | undefined {
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
