import type { ProviderKind, UsageRow, UsageSummary } from "@tide/contracts";

/** Token and money columns of the usage table; costs stay undefined when no row reported one. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  costUsd?: number;
  estimatedUsd?: number;
}

export function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
}

/** Sums rows; reported and estimated cost are summed separately and never mixed. */
export function sumRows(rows: readonly (UsageRow | UsageTotals)[]): UsageTotals {
  const out = emptyTotals();
  for (const row of rows) {
    out.inputTokens += row.inputTokens;
    out.outputTokens += row.outputTokens;
    out.cacheReadTokens += row.cacheReadTokens;
    out.cacheWriteTokens += row.cacheWriteTokens;
    out.turns += row.turns;
    if (row.costUsd !== undefined) out.costUsd = (out.costUsd ?? 0) + row.costUsd;
    if (row.estimatedUsd !== undefined) out.estimatedUsd = (out.estimatedUsd ?? 0) + row.estimatedUsd;
  }
  return out;
}

export function totalTokens(t: UsageTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

export interface HarnessGroup {
  /** instance id: `claude`, `codex:work` */
  id: string;
  provider: ProviderKind;
  rows: UsageRow[];
  totals: UsageTotals;
}

/** Rows grouped by harness instance, heaviest harness first; inside, heaviest model first, Tide before external on a tie. */
export function groupByHarness(rows: readonly UsageRow[]): HarnessGroup[] {
  const groups = new Map<string, HarnessGroup>();
  for (const row of rows) {
    const id = row.providerId ?? row.provider;
    const group = groups.get(id) ?? { id, provider: row.provider, rows: [], totals: emptyTotals() };
    group.rows.push(row);
    groups.set(id, group);
  }
  const out = [...groups.values()].map((g) => ({
    ...g,
    rows: [...g.rows].sort(
      (a, b) =>
        totalTokens(sumRows([b])) - totalTokens(sumRows([a])) ||
        (a.source === b.source ? 0 : a.source === "tide" ? -1 : 1) ||
        (a.model ?? "").localeCompare(b.model ?? ""),
    ),
    totals: sumRows(g.rows),
  }));
  return out.sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals) || a.id.localeCompare(b.id));
}

/** Bar heights on a 0..20 scale (5 % steps) so the CSS can use a class per step, no inline styles. */
export function barStep(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.max(1, Math.round((value / max) * 20));
}

export const DAY_MS = 86_400_000;

export type UsageWindow = 7 | 30 | 90 | "custom";

/** `[since, until]` for a preset window ending now, or a custom local-date range (inclusive). */
export function windowRange(window: UsageWindow, now: number, custom?: { from: string; to: string }): { since: number; until: number } {
  if (window !== "custom") return { since: now - window * DAY_MS, until: now };
  const from = custom ? new Date(`${custom.from}T00:00:00`).getTime() : NaN;
  const to = custom ? new Date(`${custom.to}T23:59:59.999`).getTime() : NaN;
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) return { since: now - 7 * DAY_MS, until: now };
  return { since: from, until: to };
}

/** Tags a summary with the environment that produced it. */
export interface EnvUsage {
  envId?: string;
  summary?: UsageSummary;
  error?: string;
}
