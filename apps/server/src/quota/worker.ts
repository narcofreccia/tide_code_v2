import { homedir } from "node:os";
import { BUNDLED_PROVIDER_KINDS, type EventRecord, type ProviderKind, type Quota, type QuotaScope, type QuotaState } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import type { CancelTimer } from "../orchestration/limits.ts";
import type { SettingsStore } from "../settings.ts";
import { ExternalCache, scanExternal } from "../usage/external.ts";
import { exclusionFrom } from "../usage/ingest/dedupe.ts";
import { DEFAULT_PRICING, type Pricing } from "../usage/summary.ts";
import { allSpends, measureQuota, shareWindows, type OutsideSpend } from "./ledger.ts";

/** Spend outside Tide for one harness kind inside [since, until]; undefined when it was not read. */
export type OutsideSpendFn = (kind: ProviderKind, since: number, until: number) => Promise<OutsideSpend | undefined>;

export interface QuotaWorkerOptions {
  engine: Engine;
  /** `glassBox.readHarnessLogs` gates the outside spend */
  settings?: Pick<SettingsStore, "get">;
  outside?: OutsideSpendFn;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => CancelTimer;
  intervalMs?: number;
  log?: (msg: string, data?: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;
const STEP_PCT = 5;
const KINDS: ReadonlySet<string> = new Set<string>(BUNDLED_PROVIDER_KINDS);
/** events after which a scope's figure may have moved */
const TRIGGERS: ReadonlySet<string> = new Set(["usage.reported", "usage.corrected", "quota.changed", "turn.settled"]);

const realTimer = (fn: () => void, ms: number): CancelTimer => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/** Whether a new measurement says something the stored one does not (a lift and the time do not count). */
export function meterChanged(prev: QuotaState | undefined, next: QuotaState, now: number): boolean {
  if (prev === undefined) return true;
  // a window that ended is what frees a held scope: always record the measurement after it
  if (prev.windowEndsAt !== undefined && prev.windowEndsAt <= now) return true;
  if (prev.status !== next.status || prev.windowEndsAt !== next.windowEndsAt) return true;
  if (prev.over.length !== next.over.length || prev.over.some((id, i) => id !== next.over[i])) return true;
  return Math.floor(prev.usedPct / STEP_PCT) !== Math.floor(next.usedPct / STEP_PCT);
}

/** Harness-log spend through the usage page's scanner, cached five minutes per window. */
export function harnessLogSpend(options: { engine: Engine; tideHome?: string; home?: string; pricing?: Pricing; scan?: typeof scanExternal; now?: () => number }): OutsideSpendFn {
  const cache = new ExternalCache({ ...(options.now !== undefined ? { now: options.now } : {}) });
  const scan = options.scan ?? scanExternal;
  const pricing = options.pricing ?? DEFAULT_PRICING;
  return async (kind, since, until) => {
    // keyed by the window start: `until` (now) moves every tick
    const result = await cache.get(`quota:${since}`, () =>
      scan({ home: options.home ?? homedir(), since, until, exclusion: exclusionFrom(options.engine.getModel(), options.tideHome) }),
    );
    let usd = 0;
    let approx = false;
    for (const b of result.buckets) {
      if (b.provider !== kind) continue;
      if (b.count > 0 && b.reported === b.count) {
        usd += b.cost;
        continue;
      }
      approx = true;
      usd += pricing.estimate(b.model, b.tokens) ?? 0;
    }
    return { usd, approx };
  };
}

/**
 * Measures every quota and records a measurement (`quota.meter`) only when it changes what the
 * clients show or what the decider holds. Runs every minute and right after usage moves.
 */
export class QuotaWorker {
  #engine: Engine;
  #settings: QuotaWorkerOptions["settings"];
  #outside: OutsideSpendFn | undefined;
  #now: () => number;
  #schedule: (fn: () => void, ms: number) => CancelTimer;
  #intervalMs: number;
  #log: (msg: string, data?: unknown) => void;
  #cancel: CancelTimer | undefined;
  #unsubscribe: (() => void) | undefined;
  #running = false;
  #inFlight: Promise<void> | undefined;
  #again = false;

  constructor(options: QuotaWorkerOptions) {
    this.#engine = options.engine;
    this.#settings = options.settings;
    this.#outside = options.outside;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule = options.schedule ?? realTimer;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#log = options.log ?? (() => undefined);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#unsubscribe = this.#engine.subscribe((record) => this.#onEvent(record));
    this.#arm();
    this.request();
  }

  stop(): void {
    this.#running = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#cancel?.();
    this.#cancel = undefined;
  }

  #arm(): void {
    if (!this.#running) return;
    this.#cancel = this.#schedule(() => {
      this.request();
      void this.drain().finally(() => this.#arm());
    }, this.#intervalMs);
  }

  #onEvent(record: EventRecord): void {
    if (TRIGGERS.has(record.event.type)) this.request();
  }

  /**
   * Asks for a pass. Requests made while one is pending or running fold into a single further
   * pass, so a burst of events (one command appends several) costs one measurement.
   */
  request(): void {
    if (this.#inFlight !== undefined) {
      this.#again = true;
      return;
    }
    this.#inFlight = (async () => {
      do {
        // let the command that triggered us finish appending before the model is read
        await Promise.resolve();
        this.#again = false;
        await this.tick();
      } while (this.#again && this.#running);
    })()
      .catch((err: unknown) => this.#log("[quota] metering failed", err))
      .finally(() => {
        this.#inFlight = undefined;
      });
  }

  /** A pass now, awaited: the reactor calls it before settling a turn, so the settle sees this turn's usage. */
  async measureNow(): Promise<void> {
    if (!this.#running) return;
    this.request();
    await this.drain();
  }

  /** Resolves once no requested pass is pending. */
  async drain(): Promise<void> {
    while (this.#inFlight !== undefined) await this.#inFlight;
  }

  /** One measurement of every quota; returns how many states were recorded. Tests call it directly. */
  async tick(): Promise<number> {
    const model = this.#engine.getModel();
    const scopes: { scope: QuotaScope; id: string; quota: Quota; state: QuotaState | undefined }[] = [];
    for (const p of Object.values(model.projects)) if (p.quota) scopes.push({ scope: "project", id: p.id, quota: p.quota, state: p.quotaState });
    for (const t of Object.values(model.threads)) if (t.quota) scopes.push({ scope: "thread", id: t.id, quota: t.quota, state: t.quotaState });
    if (scopes.length === 0) return 0;

    const now = this.#now();
    const windows = shareWindows(model, now);
    const outside = new Map<string, OutsideSpend>();
    const readLogs = this.#settings?.get().glassBox.readHarnessLogs ?? false;
    if (readLogs && this.#outside !== undefined && scopes.some((s) => s.quota.sharePct !== undefined)) {
      // only a kind's default instance shares an account with the harness run outside Tide
      for (const w of windows) {
        if (!KINDS.has(w.instanceId)) continue;
        try {
          const spend = await this.#outside(w.instanceId as ProviderKind, w.since, Math.min(now, w.until));
          if (spend) outside.set(w.instanceId, spend);
        } catch (err) {
          this.#log("[quota] harness logs could not be read", err);
        }
      }
    }

    const spends = allSpends(model);
    let recorded = 0;
    for (const s of scopes) {
      const state = measureQuota({ model, scope: s.scope, id: s.id, quota: s.quota, now, spends, windows, outside });
      if (!meterChanged(s.state, state, now)) continue;
      try {
        await this.#engine.dispatch({ type: "quota.meter", scope: s.scope, id: s.id, state });
        recorded++;
      } catch (err) {
        this.#log("[quota] meter refused", { scope: s.scope, id: s.id, err });
      }
    }
    return recorded;
  }
}
