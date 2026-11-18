import { rootThread, threadInstanceId, type Quota, type QuotaScope, type QuotaState, type ReadModel, type Turn } from "@tide/contracts";
import { descendantsOf } from "../orchestration/decider/descendants.ts";
import { DEFAULT_PRICING, type Pricing } from "../usage/summary.ts";

// R20: what a project's or a thread's quota has used. Pure over the read model; the worker
// supplies the clock and the spend Tide cannot see in its own turns (harness logs).

export const WEEK_MS = 7 * 24 * 60 * 60_000;
/** a weekly gauge that does not say its length is taken as 7 days */
export const DEFAULT_WINDOW_MINS = 10_080;
export const WARN_AT_PCT = 80;

/** One turn's spend, filed under the instance that ran it, at the time `tideBuckets` uses. */
export interface Spend {
  threadId: string;
  instanceId: string;
  at: number;
  usd: number;
  /** from the price table (the harness reported no cost), or no price at all (counted as 0) */
  estimated: boolean;
}

/** Spend outside Tide on an instance's window (the harness's own logs), when it was read. */
export interface OutsideSpend {
  usd: number;
  approx: boolean;
}

/** The weekly window of an instance, from its gauge in `model.limits`. */
export interface ShareWindow {
  instanceId: string;
  since: number;
  until: number;
  /** share of the window already used, 0..100 (0 once the window has rolled over) */
  usedPct: number;
}

export function turnSpend(model: ReadModel, turn: Turn, pricing: Pricing = DEFAULT_PRICING): Spend | undefined {
  const u = turn.usage;
  if (!u) return undefined;
  const thread = model.threads[turn.threadId];
  const provider = turn.provider ?? thread?.provider;
  const instanceId = turn.providerId ?? turn.provider ?? (thread ? threadInstanceId(thread) : undefined);
  if (provider === undefined || instanceId === undefined) return undefined;
  const at = turn.settledAt ?? turn.startedAt ?? turn.requestedAt;
  if (u.costUsd !== undefined) return { threadId: turn.threadId, instanceId, at, usd: u.costUsd, estimated: false };
  const cacheRead = u.cacheReadTokens ?? 0;
  // Codex counts cached input inside inputTokens (as tideBuckets splits it)
  const input = provider === "codex" ? Math.max(0, u.inputTokens - cacheRead) : u.inputTokens;
  const usd = pricing.estimate(turn.model ?? thread?.model, { in: input, out: u.outputTokens, cacheRead, cacheWrite: u.cacheWriteTokens ?? 0 });
  return { threadId: turn.threadId, instanceId, at, usd: usd ?? 0, estimated: true };
}

export function allSpends(model: ReadModel, pricing?: Pricing): Spend[] {
  const out: Spend[] = [];
  for (const turn of Object.values(model.turns)) {
    const s = turnSpend(model, turn, pricing);
    if (s) out.push(s);
  }
  return out;
}

/** The threads whose spend counts against a scope. */
export function scopeThreads(model: ReadModel, scope: QuotaScope, id: string): Set<string> {
  if (scope === "thread") return new Set([id, ...descendantsOf(model, id).map((t) => t.id)]);
  const ids = new Set<string>();
  // a delegate may live in another project and still counts where the work started
  for (const t of Object.values(model.threads)) if (rootThread(model, t).projectId === id) ids.add(t.id);
  return ids;
}

/** Every instance with a weekly gauge that says how much is left and when it resets. */
export function shareWindows(model: ReadModel, now: number): ShareWindow[] {
  const out: ShareWindow[] = [];
  for (const [instanceId, gauges] of Object.entries(model.limits ?? {})) {
    const weekly = gauges.weekly;
    if (weekly?.remainingPct === undefined || weekly.resetsAt === undefined) continue;
    const until = weekly.resetsAt;
    const since = until - (weekly.windowMins ?? DEFAULT_WINDOW_MINS) * 60_000;
    // a window that has already reset says nothing about the new one
    const usedPct = until <= now ? 0 : Math.min(100, Math.max(0, 100 - weekly.remainingPct));
    out.push({ instanceId, since, until, usedPct });
  }
  return out;
}

export interface MeasureInput {
  model: ReadModel;
  scope: QuotaScope;
  id: string;
  quota: Quota;
  now: number;
  /** precomputed by the caller when several scopes are measured at once */
  spends?: readonly Spend[];
  windows?: readonly ShareWindow[];
  /** outside spend per instance id, for that instance's window */
  outside?: ReadonlyMap<string, OutsideSpend>;
  pricing?: Pricing;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The quota's state now. `liftedUntil` is not set here (the decider carries a live lift forward). */
export function measureQuota(input: MeasureInput): QuotaState {
  const { model, quota, now } = input;
  const spends = input.spends ?? allSpends(model, input.pricing);
  const threads = scopeThreads(model, input.scope, input.id);
  let approx = false;
  const over: string[] = [];
  let windowEndsAt: number | undefined;
  let sharePct: number | undefined;
  let usdPct: number | undefined;

  if (quota.sharePct !== undefined) {
    sharePct = 0;
    for (const w of input.windows ?? shareWindows(model, now)) {
      let mine = 0;
      let all = 0;
      let estimated = false;
      for (const s of spends) {
        if (s.instanceId !== w.instanceId || s.at < w.since || s.at > w.until) continue;
        all += s.usd;
        if (threads.has(s.threadId)) {
          mine += s.usd;
          estimated ||= s.estimated;
        }
      }
      const outside = input.outside?.get(w.instanceId);
      if (outside) all += outside.usd;
      if (mine <= 0) continue;
      if (estimated || outside?.approx === true) approx = true;
      const share = all > 0 ? (w.usedPct * mine) / all : 0;
      sharePct = Math.max(sharePct, (share / quota.sharePct) * 100);
      if (share >= quota.sharePct) {
        over.push(w.instanceId);
        windowEndsAt = windowEndsAt === undefined ? w.until : Math.min(windowEndsAt, w.until);
      }
    }
  }

  if (quota.usdPerWeek !== undefined) {
    let mine = 0;
    for (const s of spends) {
      if (s.at <= now - WEEK_MS || s.at > now || !threads.has(s.threadId)) continue;
      mine += s.usd;
      if (s.estimated) approx = true;
    }
    usdPct = (mine / quota.usdPerWeek) * 100;
    if (mine >= quota.usdPerWeek) {
      over.push("*");
      // the rolling cap has no window to wait for: a share window ending must not free it
      windowEndsAt = undefined;
    }
  }

  const basis: QuotaState["basis"] = usdPct === undefined || (sharePct !== undefined && sharePct > usdPct) ? "share" : "usd";
  const usedPct = round1(Math.max(0, (basis === "share" ? sharePct : usdPct) ?? 0));
  if (basis === "share") approx = true;
  over.sort();
  const status: QuotaState["status"] = over.length > 0 ? "exceeded" : usedPct >= WARN_AT_PCT ? "warning" : "ok";
  return {
    status,
    usedPct,
    basis,
    over,
    ...(windowEndsAt !== undefined ? { windowEndsAt } : {}),
    ...(approx ? { approx: true } : {}),
    at: now,
  };
}
