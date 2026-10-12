import type { ProviderKind, RateLimit, ReadModel, Thread } from "@tide/contracts";

// ---- cost ----

/** What one harness cost, today and over the project's whole life. */
export interface ProviderCost {
  provider: ProviderKind;
  todayUsd: number;
  lifetimeUsd: number;
}

/** Money spent, as the harnesses reported it per turn (`turn.usage.costUsd`). */
export interface CostRollup {
  /** turns that settled during the local day of `now` */
  todayUsd: number;
  lifetimeUsd: number;
  /** providers that reported any cost, most expensive (lifetime) first */
  byProvider: ProviderCost[];
}

function isSameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * Sums `turn.usage.costUsd` (itself the sum of the turn's per-report deltas).
 * Scoped to the given projects (all when omitted). Archived threads still count:
 * the money was spent. "Today" means the turn *settled* today, local time — a
 * thread touched today does not drag its lifetime cost into today's figure.
 * A turn is billed to the harness that ran it (`turn.provider`), falling back
 * to the thread's.
 */
export function selectCostRollup(model: ReadModel, projectIds?: readonly string[], now = Date.now()): CostRollup {
  const scope = projectIds === undefined ? undefined : new Set(projectIds);
  const byProvider = new Map<ProviderKind, ProviderCost>();
  let todayUsd = 0;
  let lifetimeUsd = 0;
  for (const turn of Object.values(model.turns)) {
    const cost = turn.usage?.costUsd;
    if (cost === undefined || cost === 0) continue;
    const thread = model.threads[turn.threadId];
    if (!thread || (scope !== undefined && !scope.has(thread.projectId))) continue;
    const today = turn.settledAt !== undefined && isSameLocalDay(turn.settledAt, now);
    const provider = turn.provider ?? thread.provider;
    const row = byProvider.get(provider) ?? { provider, todayUsd: 0, lifetimeUsd: 0 };
    row.lifetimeUsd += cost;
    lifetimeUsd += cost;
    if (today) {
      row.todayUsd += cost;
      todayUsd += cost;
    }
    byProvider.set(provider, row);
  }
  return {
    todayUsd,
    lifetimeUsd,
    byProvider: [...byProvider.values()].sort(
      (a, b) => b.lifetimeUsd - a.lifetimeUsd || a.provider.localeCompare(b.provider),
    ),
  };
}

/** Compact per-project numbers for the Mission Control totals strip. */
export interface ProjectTotals {
  threads: number;
  running: number;
  needsYou: number;
  /** turns settled today (local), from `turn.usage.costUsd` */
  costTodayUsd: number;
  costLifetimeUsd: number;
  costByProvider: ProviderCost[];
  /** highest context usage across the project's threads; percentages don't add up */
  maxContextPercent?: number;
}

/**
 * Totals over a project's non-archived threads (cost includes archived ones —
 * see `selectCostRollup`). `now` is injectable so "today" is testable. Context
 * is reported as the max, never a sum.
 */
export function selectProjectTotals(model: ReadModel, projectId: string, now = Date.now()): ProjectTotals {
  const threads = Object.values(model.threads).filter(
    (t) => t.projectId === projectId && t.archivedAt === undefined,
  );
  let running = 0;
  let needsYou = 0;
  let maxContextPercent: number | undefined;
  for (const thread of threads) {
    if (thread.status === "running") running += 1;
    if (thread.attention !== undefined) needsYou += 1;
    const context = thread.contextUsage;
    if (context && context.window > 0) {
      const percent = Math.round((context.used / context.window) * 100);
      if (maxContextPercent === undefined || percent > maxContextPercent) maxContextPercent = percent;
    }
  }
  const cost = selectCostRollup(model, [projectId], now);
  return {
    threads: threads.length,
    running,
    needsYou,
    costTodayUsd: cost.todayUsd,
    costLifetimeUsd: cost.lifetimeUsd,
    costByProvider: cost.byProvider,
    ...(maxContextPercent === undefined ? {} : { maxContextPercent }),
  };
}

// ---- rate limits ----

const SEVERITY: Record<RateLimit["status"], number> = { ok: 0, warning: 1, limited: 2 };

/** The more severe of two reports; on a tie the more recent one. */
export function worstRateLimit(a: RateLimit | undefined, b: RateLimit | undefined): RateLimit | undefined {
  if (!a) return b;
  if (!b) return a;
  const diff = SEVERITY[a.status] - SEVERITY[b.status];
  if (diff !== 0) return diff > 0 ? a : b;
  return b.at > a.at ? b : a;
}

/**
 * Worst rate-limit status per harness across live threads — the subscription is
 * shared, so one limited thread means the provider is limited for all of them.
 */
export function selectProviderRateLimits(model: ReadModel): Partial<Record<ProviderKind, RateLimit>> {
  const out: Partial<Record<ProviderKind, RateLimit>> = {};
  for (const thread of Object.values(model.threads) as Thread[]) {
    if (thread.archivedAt !== undefined || !thread.rateLimit) continue;
    const worst = worstRateLimit(out[thread.provider], thread.rateLimit);
    if (worst) out[thread.provider] = worst;
  }
  return out;
}
