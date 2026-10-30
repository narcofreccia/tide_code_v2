import type { ProviderKind, ReadModel, UsageRow, UsageSummary } from "@tide/contracts";
import { BucketSet, type Bucket } from "./buckets.ts";
import type { ExternalResult } from "./external.ts";
import { estimate as defaultEstimate, PRICING_VERSION } from "./pricing.ts";
import type { UsageTokens } from "./types.ts";

export interface Pricing {
  version: string;
  estimate: (model: string | undefined, tokens: UsageTokens) => number | undefined;
}

export const DEFAULT_PRICING: Pricing = { version: PRICING_VERSION, estimate: defaultEstimate };

export interface SummarizeInput {
  model: ReadModel;
  since: number;
  until: number;
  /** absent = external logs were not read; `externalNote` says why */
  external?: ExternalResult;
  externalNote?: string;
  pricing?: Pricing;
}

const LABEL: Record<ProviderKind, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", pi: "Pi", acp: "ACP agents" };

/**
 * Tide's turns as buckets. Codex counts cached input inside `inputTokens` (OpenAI totals);
 * it is split here so `inputTokens` means uncached input on every row.
 */
export function tideBuckets(model: ReadModel, since: number, until: number): Bucket[] {
  const set = new BucketSet();
  for (const turn of Object.values(model.turns)) {
    const u = turn.usage;
    if (!u) continue;
    const at = turn.settledAt ?? turn.startedAt ?? turn.requestedAt;
    if (at < since || at > until) continue;
    const thread = model.threads[turn.threadId];
    const provider = turn.provider ?? thread?.provider;
    if (provider === undefined) continue;
    const cacheRead = u.cacheReadTokens ?? 0;
    const input = provider === "codex" ? Math.max(0, u.inputTokens - cacheRead) : u.inputTokens;
    set.add({
      at,
      provider,
      providerId: turn.providerId ?? thread?.providerId,
      model: turn.model ?? thread?.model,
      source: "tide",
      tokens: { in: input, out: u.outputTokens, cacheRead, cacheWrite: u.cacheWriteTokens ?? 0 },
      costUsd: u.costUsd,
    });
  }
  return set.list();
}

interface Acc {
  row: UsageRow;
  cost: number;
  reported: number;
  estimated: number;
  /** some bucket had no price */
  unpriced: boolean;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

export function summarize(input: SummarizeInput): UsageSummary {
  const pricing = input.pricing ?? DEFAULT_PRICING;
  const buckets = [...tideBuckets(input.model, input.since, input.until), ...(input.external?.buckets ?? [])];
  const rows = new Map<string, Acc>();
  const days = new Map<string, { tokens: number; cost: number; reported: number; count: number; estimated: number; priced: boolean }>();
  const unpricedModels = new Set<string>();

  for (const b of buckets) {
    const est = pricing.estimate(b.model, b.tokens);
    if (est === undefined) unpricedModels.add(b.model ?? `${LABEL[b.provider]} (model not recorded)`);
    // external rows group by provider+model; tide rows also by instance
    const key = [b.source, b.provider, b.source === "tide" ? (b.providerId ?? "") : "", b.model ?? ""].join("\u0000");
    let acc = rows.get(key);
    if (!acc) {
      acc = {
        row: {
          provider: b.provider,
          source: b.source,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          turns: 0,
          ...(b.source === "tide" && b.providerId !== undefined ? { providerId: b.providerId } : {}),
          ...(b.model !== undefined ? { model: b.model } : {}),
        },
        cost: 0,
        reported: 0,
        estimated: 0,
        unpriced: false,
      };
      rows.set(key, acc);
    }
    acc.row.inputTokens += b.tokens.in;
    acc.row.outputTokens += b.tokens.out;
    acc.row.cacheReadTokens += b.tokens.cacheRead;
    acc.row.cacheWriteTokens += b.tokens.cacheWrite;
    acc.row.turns += b.count;
    acc.cost += b.cost;
    acc.reported += b.reported;
    if (est === undefined) acc.unpriced = true;
    else acc.estimated += est;

    let d = days.get(b.day);
    if (!d) days.set(b.day, (d = { tokens: 0, cost: 0, reported: 0, count: 0, estimated: 0, priced: false }));
    d.tokens += b.tokens.in + b.tokens.out + b.tokens.cacheRead + b.tokens.cacheWrite;
    d.cost += b.cost;
    d.reported += b.reported;
    d.count += b.count;
    if (est !== undefined) {
      d.estimated += est;
      d.priced = true;
    }
  }

  const noCost = new Set<ProviderKind>();
  const partialCost = new Set<ProviderKind>();
  const outRows: UsageRow[] = [];
  for (const acc of rows.values()) {
    const row = acc.row;
    if (acc.reported === row.turns && row.turns > 0) row.costUsd = round(acc.cost);
    else if (acc.reported === 0) noCost.add(row.provider);
    else partialCost.add(row.provider);
    // an estimate that silently left out unpriced calls would understate; show none instead
    if (!acc.unpriced) row.estimatedUsd = round(acc.estimated);
    outRows.push(row);
  }
  outRows.sort((a, b) => (b.costUsd ?? b.estimatedUsd ?? 0) - (a.costUsd ?? a.estimatedUsd ?? 0) || b.outputTokens - a.outputTokens);

  const notes: string[] = [];
  for (const p of noCost) notes.push(`${LABEL[p]} did not report a cost for these calls; shown as an estimate.`);
  for (const p of partialCost) if (!noCost.has(p)) notes.push(`Some ${LABEL[p]} calls reported no cost; those rows show an estimate only.`);
  if (unpricedModels.size > 0) notes.push(`No price for ${[...unpricedModels].sort().join(", ")}; no estimate shown for those rows.`);
  notes.push(`Estimates use Tide's price table ${pricing.version} (API list prices); a subscription is not billed per token.`);
  if (input.externalNote !== undefined) notes.push(input.externalNote);
  notes.push(...(input.external?.notes ?? []));

  const outDays = [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, d]) => ({
      day,
      tokens: d.tokens,
      ...(d.count > 0 && d.reported === d.count ? { costUsd: round(d.cost) } : {}),
      ...(d.priced ? { estimatedUsd: round(d.estimated) } : {}),
    }));

  return { since: input.since, until: input.until, rows: outRows, days: outDays, notes, pricingVersion: pricing.version };
}
