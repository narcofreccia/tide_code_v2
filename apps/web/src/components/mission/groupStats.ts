import { selectPrCounts, selectProjectTotals, selectRecentThreads, type ProjectTotals } from "@tide/client";
import type { ReadModel, Thread } from "@tide/contracts";

/** `selectProjectTotals` summed over a repo group's clones (context percent is the max, not a sum). */
export function groupTotals(model: ReadModel, ids: readonly string[]): ProjectTotals {
  const all = ids.map((id) => selectProjectTotals(model, id));
  const first = all[0];
  if (all.length === 1 && first !== undefined) return first;
  const byProvider = new Map<string, { provider: ProjectTotals["costByProvider"][number]["provider"]; todayUsd: number; lifetimeUsd: number }>();
  for (const t of all) {
    for (const c of t.costByProvider) {
      const hit = byProvider.get(c.provider);
      if (hit) {
        hit.todayUsd += c.todayUsd;
        hit.lifetimeUsd += c.lifetimeUsd;
      } else byProvider.set(c.provider, { ...c });
    }
  }
  const ctx = all.map((t) => t.maxContextPercent).filter((n): n is number => n !== undefined);
  return {
    threads: all.reduce((n, t) => n + t.threads, 0),
    running: all.reduce((n, t) => n + t.running, 0),
    needsYou: all.reduce((n, t) => n + t.needsYou, 0),
    costTodayUsd: all.reduce((n, t) => n + t.costTodayUsd, 0),
    costLifetimeUsd: all.reduce((n, t) => n + t.costLifetimeUsd, 0),
    costByProvider: [...byProvider.values()],
    ...(ctx.length > 0 ? { maxContextPercent: Math.max(...ctx) } : {}),
  };
}

export function groupPrs(model: ReadModel, ids: readonly string[]): ReturnType<typeof selectPrCounts> {
  const out = { open: 0, merged: 0, closed: 0, landed: 0 };
  for (const id of ids) {
    const c = selectPrCounts(model, id);
    out.open += c.open;
    out.merged += c.merged;
    out.closed += c.closed;
    out.landed += c.landed;
  }
  return out;
}

/** The newest threads across every clone. */
export function groupRecent(model: ReadModel, ids: readonly string[], limit: number): Thread[] {
  return ids
    .flatMap((id) => selectRecentThreads(model, id, limit))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, limit);
}
