import type { JudgeSite, JudgeSource } from "@tide/contracts";
import { DEFAULT_LIMITS, DecisionLimitError, type Limits } from "./client.ts";
import { DEFAULT_CAPS, fit, pack, packState, type SiteCaps } from "./budget.ts";
import type { State } from "./wire.ts";

/**
 * The judge: one entry point (`ask`) every decision site uses. Jev (TypeSafe's calibrated
 * classifier) is the first filter; verdicts below the gray-zone threshold go to the user's
 * fallback harness model, item by item. With the feature off, or no backend, every verdict is
 * `source: "none"` and callers behave as without the layer. Pure orchestration: backends do I/O.
 */

/** One sub-question. `threshold`: below this confidence the fallback is asked (0 = never). */
export type Ask =
  | { kind: "label"; instructions: string; labels: Record<string, string>; threshold?: number }
  | { kind: "yes-no"; instructions: string; threshold?: number }
  | { kind: "score"; instructions: string; levels: string[]; threshold?: number };

interface QuestionBase {
  /** stable id; verdict ids derive from it */
  id: string;
  site: JudgeSite;
  threshold?: number;
}

/** One state, one question; the verdict id is `id`. */
export type SingleQuestion = QuestionBase & Ask & { state: State };

/**
 * The same question(s) about many items. Each item's state is sent at most once (see budget.ts).
 * Either one question (`instructions` + `labels`, or yes-no without labels) with verdict ids
 * `${id}:${key}`, or a `questions` map with ids `${id}:${key}:${name}`.
 */
export interface PerItemQuestion extends QuestionBase {
  kind: "per-item";
  shared?: State;
  items: { key: string; state: State }[];
  instructions?: string;
  labels?: Record<string, string>;
  questions?: Record<string, Ask>;
}

export type JudgeQuestion = SingleQuestion | PerItemQuestion;

export interface JudgeVerdict {
  id: string;
  label?: string;
  /** 0..1: yes probability, or the score level normalised by (levels - 1) */
  score?: number;
  confidence: number;
  source: JudgeSource;
  costUsd?: number;
  tokens: number;
  elapsedMs: number;
  model?: string;
  /** the request this verdict shared with others (ledger call counting) */
  callId?: string;
  error?: string;
}

/** One unit the backends answer: a verdict id and its question. */
export interface JudgeUnit {
  id: string;
  ask: Ask;
  /** per-item: the item key (the instructions already name it) */
  item?: string;
}

/** One request: a state and the questions about it. */
export interface JudgeCall {
  site: JudgeSite;
  state: State;
  /** the site's state cap (the fallback clips to it) */
  stateTokens: number;
  units: JudgeUnit[];
}

export interface JudgeBackend {
  readonly name: "jev" | "fallback";
  available(): boolean;
  /** One verdict per unit; a failed call yields verdicts with `error` (it should not reject). */
  ask(calls: JudgeCall[], options: { timeoutMs?: number }): Promise<JudgeVerdict[]>;
}

export interface LedgerSink {
  record(entry: JudgeVerdict & { site: JudgeSite; at: number }): void;
}

export interface JudgeOptions {
  jev: JudgeBackend;
  fallback?: JudgeBackend;
  ledger?: LedgerSink;
  grayZone: () => { low: number; high: number };
  siteEnabled: (site: JudgeSite) => boolean;
  caps?: Partial<Record<JudgeSite, SiteCaps>>;
  limits?: Limits;
  now?: () => number;
  log?: (msg: string, data?: unknown) => void;
}

export const OVER_BUDGET = "over budget";

export const noneVerdict = (id: string, error?: string): JudgeVerdict => ({ id, confidence: 0, source: "none", tokens: 0, elapsedMs: 0, ...(error !== undefined ? { error } : {}) });

const itemPrefix = (key: string, instructions: string): string => `About item "${key}": ${instructions}`;

function withInstructions(ask: Ask, instructions: string): Ask {
  return { ...ask, instructions };
}

/** The flat list of units a question asks, in order. */
export function unitsOf(q: JudgeQuestion): JudgeUnit[] {
  if (q.kind !== "per-item") {
    const { id: _id, site: _site, state: _state, ...ask } = q;
    return [{ id: q.id, ask: ask as Ask }];
  }
  const out: JudgeUnit[] = [];
  for (const item of q.items) {
    if (q.questions !== undefined) {
      for (const [name, ask] of Object.entries(q.questions)) out.push({ id: `${q.id}:${item.key}:${name}`, item: item.key, ask: withInstructions(ask, itemPrefix(item.key, ask.instructions)) });
    } else {
      const instructions = itemPrefix(item.key, q.instructions ?? "");
      const ask: Ask = q.labels !== undefined ? { kind: "label", instructions, labels: q.labels } : { kind: "yes-no", instructions };
      out.push({ id: `${q.id}:${item.key}`, item: item.key, ask });
    }
  }
  return out;
}

export class Judge {
  #jev: JudgeBackend;
  #fallback: JudgeBackend | undefined;
  #ledger: LedgerSink | undefined;
  #grayZone: () => { low: number; high: number };
  #siteEnabled: (site: JudgeSite) => boolean;
  #caps: Record<JudgeSite, SiteCaps>;
  #limits: Limits;
  #now: () => number;
  #log: (msg: string, data?: unknown) => void;

  constructor(options: JudgeOptions) {
    this.#jev = options.jev;
    this.#fallback = options.fallback;
    this.#ledger = options.ledger;
    this.#grayZone = options.grayZone;
    this.#siteEnabled = options.siteEnabled;
    this.#caps = { ...DEFAULT_CAPS, ...options.caps };
    this.#limits = options.limits ?? DEFAULT_LIMITS;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => undefined);
  }

  /** Whether `ask` on this site would reach any backend (callers skip work otherwise). */
  enabled(site: JudgeSite): boolean {
    return this.#siteEnabled(site) && (this.#jev.available() || this.#fallback?.available() === true);
  }

  grayZone(): { low: number; high: number } {
    return this.#grayZone();
  }

  async ask(question: JudgeQuestion, options: { timeoutMs?: number } = {}): Promise<JudgeVerdict[]> {
    const units = unitsOf(question);
    if (!this.enabled(question.site)) return units.map((u) => noneVerdict(u.id));
    const caps = this.#caps[question.site];
    const verdicts = new Map<string, JudgeVerdict>();
    const refused = new Set<string>();

    // budget: pack items (or fit the single state); what cannot fit is refused, never split
    let calls: JudgeCall[] = [];
    if (question.kind === "per-item") {
      const packed = pack(question, units, caps, this.#limits);
      calls = packed.calls;
      for (const u of packed.refused) refused.add(u.id);
    } else {
      try {
        calls = [fit(question, units, caps, this.#limits)];
      } catch (err) {
        if (!(err instanceof DecisionLimitError)) throw err;
        for (const u of units) refused.add(u.id);
      }
    }
    for (const id of refused) verdicts.set(id, noneVerdict(id, OVER_BUDGET));

    // Jev
    const jevUnits = calls.flatMap((c) => c.units);
    if (calls.length > 0) {
      if (this.#jev.available()) {
        let answered: JudgeVerdict[];
        try {
          answered = await this.#jev.ask(calls, options);
        } catch (err) {
          answered = jevUnits.map((u) => noneVerdict(u.id, (err as Error)?.message ?? String(err)));
        }
        const byId = new Map(answered.map((v) => [v.id, v]));
        for (const u of jevUnits) verdicts.set(u.id, byId.get(u.id) ?? noneVerdict(u.id, "no answer"));
      } else for (const u of jevUnits) verdicts.set(u.id, noneVerdict(u.id));
    }
    this.#record(question.site, [...verdicts.values()].filter((v) => v.source !== "none" || v.error !== undefined));

    // fallback: only the gray-zone units, one state per item
    const gray = jevUnits.filter((u) => (verdicts.get(u.id)?.confidence ?? 0) < this.#threshold(question, u));
    if (gray.length > 0 && this.#fallback?.available() === true) {
      const fbCalls = gray.map((u) => this.#fallbackCall(question, u, caps));
      let answered: JudgeVerdict[] = [];
      try {
        answered = await this.#fallback.ask(fbCalls, options);
      } catch (err) {
        this.#log("[judge] fallback failed", err);
      }
      this.#record(question.site, answered);
      for (const v of answered) if (v.error === undefined && verdicts.has(v.id)) verdicts.set(v.id, { ...v, source: "fallback" });
    }
    return units.map((u) => verdicts.get(u.id) ?? noneVerdict(u.id));
  }

  #threshold(question: JudgeQuestion, unit: JudgeUnit): number {
    return unit.ask.threshold ?? question.threshold ?? this.#grayZone().high;
  }

  #fallbackCall(question: JudgeQuestion, unit: JudgeUnit, caps: SiteCaps): JudgeCall {
    if (question.kind !== "per-item") return { site: question.site, state: question.state, stateTokens: caps.stateTokens, units: [unit] };
    const item = question.items.find((i) => i.key === unit.item);
    return { site: question.site, state: packState(question.shared, item !== undefined ? [item] : []), stateTokens: caps.stateTokens, units: [unit] };
  }

  #record(site: JudgeSite, verdicts: JudgeVerdict[]): void {
    if (!this.#ledger) return;
    const at = this.#now();
    for (const v of verdicts) {
      try {
        this.#ledger.record({ ...v, site, at });
      } catch (err) {
        this.#log("[judge] ledger write failed", err);
      }
    }
  }
}
