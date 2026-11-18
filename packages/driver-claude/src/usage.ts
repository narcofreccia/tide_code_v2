import type { NormalizedEvent, RateLimit, TurnUsage } from "@tide/contracts";
import { type CostState, type CostStatesFn, sumModelUsage, type TokenTotals } from "./cost-state.ts";
import type { RateLimitInfoShape, ResultMessage } from "./sdk-shapes.ts";

/**
 * Turns Claude Code's cumulative `result` figures into per-turn deltas.
 *
 * `total_cost_usd` and `modelUsage` are running totals for the `query()` (main loop, every
 * sub-agent, compaction), and a query that resumes or forks a session starts from the totals
 * its transcript saved (`cost-state` lines). `result.usage` is per turn and main loop only, so
 * it is the fallback for tokens, never diffed. The tracker belongs to the session and outlives
 * each query, so a rebuilt query (rollback, interrupt teardown, a lost CLI) still knows where
 * the previous one stopped.
 *
 * Baseline of a query = the candidate with the largest cost not above the first reported
 * total, among: zero, the tracker's last totals (only on a resume), and every `cost-state` of
 * the transcript resumed or forked from. A wrong pick can only under-report, never inflate.
 */
interface Totals {
  cost?: number;
  tokens?: TokenTotals;
}

const ZERO: Totals = { cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const round = (value: number): number => Math.round(value * 1e8) / 1e8;

function cumulative(message: ResultMessage): Totals {
  const tokens = sumModelUsage(message.modelUsage);
  return { ...(typeof message.total_cost_usd === "number" ? { cost: message.total_cost_usd } : {}), ...(tokens ? { tokens } : {}) };
}

function tokenSum(tokens: TokenTotals | undefined): number {
  return tokens ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite : 0;
}

/** Crash and startup-error results may carry zeroed figures: they say nothing about the totals. */
function zeroed(now: Totals, message: ResultMessage): boolean {
  const usage = message.usage ?? {};
  const perTurn = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return (now.cost ?? 0) === 0 && tokenSum(now.tokens) === 0 && perTurn === 0;
}

/** What a candidate is compared on: cost when the result reports it, else total tokens. */
function size(totals: Totals, byCost: boolean): number | undefined {
  return byCost ? totals.cost : totals.tokens ? tokenSum(totals.tokens) : undefined;
}

export class UsageTracker {
  #last: Totals | undefined;
  #firstOfQuery = true;
  #resumed = false;
  /** `cost-state` entries of the transcript this query resumes; `undefined` = unreadable */
  #states: CostState[] | undefined = [];
  #loading: Promise<void> | undefined;

  /**
   * A new `query()` starts. `source` is the session it resumes or forks (none for a brand-new
   * session); its transcript is read once, here.
   */
  beginQuery(source: string | undefined, read: () => Promise<CostState[] | undefined>): void {
    this.#firstOfQuery = true;
    this.#resumed = source !== undefined;
    this.#states = [];
    this.#loading = undefined;
    if (source === undefined) return;
    this.#states = undefined;
    this.#loading = read().then(
      (states) => {
        this.#states = states;
      },
      () => {
        this.#states = undefined;
      },
    );
  }

  /** Settles once the transcript read of the current query is done; await before a `result`. */
  ready(): Promise<void> {
    return this.#loading ?? Promise.resolve();
  }

  /** The `usage` delta for a `result`. */
  result(message: ResultMessage): TurnUsage {
    const now = cumulative(message);
    const perTurn = fromUsage(message);
    if (zeroed(now, message)) return { ...perTurn };
    if (this.#firstOfQuery) {
      this.#firstOfQuery = false;
      if (this.#resumed && this.#states === undefined) {
        // the restored totals are unknown: report this turn's tokens without a cost, and count
        // later turns from here
        this.#last = now;
        return perTurn;
      }
      return this.#delta(now, this.#baseline(now), perTurn);
    }
    let base = this.#last ?? ZERO;
    // a mid-session /clear resets the running totals
    if (now.cost !== undefined && base.cost !== undefined && now.cost < base.cost) base = ZERO;
    return this.#delta(now, base, perTurn);
  }

  #baseline(now: Totals): Totals {
    const byCost = now.cost !== undefined;
    const reported = size(now, byCost);
    const candidates: Totals[] = [ZERO, ...(this.#states ?? [])];
    if (this.#resumed && this.#last) candidates.push(this.#last);
    if (reported === undefined) return ZERO;
    let best = ZERO;
    let bestSize = 0;
    for (const candidate of candidates) {
      const value = size(candidate, byCost);
      if (value === undefined || value > reported || value < bestSize) continue;
      best = candidate;
      bestSize = value;
    }
    return best;
  }

  #delta(now: Totals, base: Totals, perTurn: TurnUsage): TurnUsage {
    this.#last = now;
    const cost = now.cost !== undefined ? { costUsd: round(Math.max(0, now.cost - (base.cost ?? 0))) } : {};
    if (!now.tokens || !base.tokens) return { ...perTurn, ...cost };
    const d = (key: keyof TokenTotals): number => Math.max(0, now.tokens![key] - base.tokens![key]);
    return { inputTokens: d("input"), outputTokens: d("output"), cacheReadTokens: d("cacheRead"), cacheWriteTokens: d("cacheWrite"), ...cost };
  }
}

/** `result.usage`: this turn's main-loop tokens, as-is. */
function fromUsage(message: ResultMessage): TurnUsage {
  const usage = message.usage ?? {};
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    ...(typeof usage.cache_read_input_tokens === "number" ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
    ...(typeof usage.cache_creation_input_tokens === "number" ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
  };
}

// ---- rate limits ----

/** Used share (0..1) at which a window that is not the frame's own turns to `warning`. */
export const WARNING_USED_FRACTION = 0.9;

/** The plan windows Tide files limits under; overage and per-model windows have no slot. */
const WINDOWS: Record<string, { window: "session" | "weekly"; windowMins: number }> = {
  five_hour: { window: "session", windowMins: 300 },
  seven_day: { window: "weekly", windowMins: 10080 },
};

/**
 * A rejection that does not stop work: the exhausted window is an *overage* window
 * (`overage`, `seven_day_overage_included`) — extra usage on top of the plan, whose
 * regular windows still allow requests. Such a frame is a warning, never a block; the
 * server only marks a thread limited when its turn actually fails (docs/internals/providers.md).
 */
function overageOnly(info: RateLimitInfoShape): boolean {
  return info.status === "rejected" && info.rateLimitType !== undefined && info.rateLimitType.includes("overage");
}

/** Used share of a window, 0..1. The CLI reports fractions (0.18); a stray >1 value is read as percent. */
function fraction(raw: number | undefined): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return raw > 1 ? raw / 100 : raw;
}

const pct = (used: number): number => Math.round(used * 100);

function report(fields: { status: RateLimit["status"]; used: number | undefined; resetsAt: number | undefined; note: string; at: number; extra?: Partial<RateLimit> }): NormalizedEvent {
  return {
    type: "usage",
    rateLimit: {
      status: fields.status,
      ...(fields.used !== undefined ? { remainingPct: Math.max(0, Math.min(100, 100 - pct(fields.used))) } : {}),
      // the CLI reports epoch seconds; the contract's `at` is epoch ms, so resetsAt follows suit
      ...(typeof fields.resetsAt === "number" ? { resetsAt: fields.resetsAt * 1000 } : {}),
      ...fields.extra,
      note: fields.note,
      at: fields.at,
    },
  };
}

/**
 * `rate_limit_event` -> one `usage` report per plan window in `unifiedWindows`, the frame's
 * own window (`rateLimitType`) last with the frame's status. A frame about an overage or
 * per-model window ends with a report that names no window. The note keeps the
 * `seven_day 45% used` wording older web clients parse.
 */
export function rateLimitEvents(info: RateLimitInfoShape | undefined, at: number): NormalizedEvent[] {
  if (!info || info.status === undefined) return [];
  const type = info.rateLimitType;
  const events: NormalizedEvent[] = [];
  for (const [name, slot] of Object.entries(WINDOWS)) {
    const window = info.unifiedWindows?.[name];
    if (name === type || !window) continue;
    const used = fraction(window.utilization);
    const status = used !== undefined && used >= WARNING_USED_FRACTION ? "warning" : "ok";
    events.push(report({ status, used, resetsAt: window.resetsAt, note: `${name}${used !== undefined ? ` ${pct(used)}% used` : ""}`, at, extra: { ...slot } }));
  }
  const own = type !== undefined ? info.unifiedWindows?.[type] : undefined;
  const used = fraction(info.utilization ?? own?.utilization);
  const status = info.status === "allowed" ? "ok" : info.status === "allowed_warning" || overageOnly(info) ? "warning" : "limited";
  const overage = info.isUsingOverage ?? info.overageInUse;
  const slot = type !== undefined ? WINDOWS[type] : undefined;
  events.push(
    report({
      status,
      used,
      resetsAt: info.resetsAt ?? own?.resetsAt,
      note: `${type ?? "rate limit"}${used !== undefined ? ` ${pct(used)}% used` : ""}${info.status === "rejected" ? " (rejected)" : ""}`,
      at,
      extra: { ...(typeof overage === "boolean" ? { overage } : {}), ...slot },
    }),
  );
  return events;
}
