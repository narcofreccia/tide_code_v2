import { limitPhase, threadInstanceId, type Thread } from "@tide/contracts";
import { CommandError, type Engine } from "./engine.ts";

/** Wording harnesses use when the subscription / API window is exhausted. */
export const USAGE_LIMIT_PATTERN = /usage limit|rate limit(ed)?|quota|too many requests|\b429\b/i;

export function isUsageLimitError(text: string | undefined): boolean {
  return text !== undefined && USAGE_LIMIT_PATTERN.test(text);
}

export type CancelTimer = () => void;

export interface LimitsWorkerOptions {
  engine: Engine;
  now?: () => number;
  /** one-shot timer; the worker re-arms itself after every tick */
  schedule?: (fn: () => void, ms: number) => CancelTimer;
  intervalMs?: number;
  log?: (msg: string, data?: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;
/** a limit with no reset time is probed (resumed once to see) after this long without news */
export const PROBE_AFTER_MS = 60 * 60_000;
/** the longest wait between two probes of the same thread, and after repeated refusals */
export const MAX_BACKOFF_MS = 60 * 60_000;
const MAX_PROBE_WAIT_MS = 8 * 60 * 60_000;

const realTimer = (fn: () => void, ms: number): CancelTimer => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Wakes limited threads whose policy is "resume at reset" once the harness's window reopens
 * (`limitPhase` = ready), or probes one with no known reset after an hour. The decider owns what
 * a resume means (`thread.resume { continue }`); this only watches the clock. A `manual` thread
 * is never resumed here: the web offers "Limit reset, continue?". One resume per provider
 * instance per tick, oldest limit first, so ten threads do not hit a barely reopened window
 * together. A snooze needs nothing: the UI stops hiding the thread once `snoozedUntil` has passed.
 */
export class LimitsWorker {
  #engine: Engine;
  #now: () => number;
  #schedule: (fn: () => void, ms: number) => CancelTimer;
  #intervalMs: number;
  #log: (msg: string, data?: unknown) => void;
  #cancel: CancelTimer | undefined;
  #running = false;
  /** `${threadId}:${limited.at}` whose resume was refused: not retried before `retryAt` */
  #backoff = new Map<string, { retryAt: number; delayMs: number }>();
  /** probes sent per thread whose limit had no reset time; each one doubles the wait before the next */
  #probes = new Map<string, number>();

  constructor(options: LimitsWorkerOptions) {
    this.#engine = options.engine;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule = options.schedule ?? realTimer;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#log = options.log ?? (() => undefined);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#arm();
  }

  stop(): void {
    this.#running = false;
    this.#cancel?.();
    this.#cancel = undefined;
  }

  #arm(): void {
    if (!this.#running) return;
    this.#cancel = this.#schedule(() => {
      void this.tick().finally(() => this.#arm());
    }, this.#intervalMs);
  }

  /** Whether `thread` is due a resume now, and whether that resume is a probe. */
  #due(thread: Thread, now: number): "ready" | "probe" | undefined {
    const limited = thread.limited;
    if (limited?.resume !== "reset") return undefined;
    if (thread.archivedAt !== undefined || thread.status === "running" || thread.settledAt !== undefined) return undefined;
    const retry = this.#backoff.get(`${thread.id}:${limited.at}`);
    if (retry !== undefined && retry.retryAt > now) return undefined;
    const phase = limitPhase(this.#engine.getModel(), thread, now);
    if (phase === "ready") return "ready";
    if (phase !== "unknown") return undefined;
    const wait = Math.min(PROBE_AFTER_MS * 2 ** (this.#probes.get(thread.id) ?? 0), MAX_PROBE_WAIT_MS);
    return now - limited.at >= wait ? "probe" : undefined;
  }

  /** One pass over the read model; exposed so tests drive it without a timer. Returns the resumed thread ids. */
  async tick(): Promise<string[]> {
    const now = this.#now();
    const resumed: string[] = [];
    const model = this.#engine.getModel();
    // a thread that ran to completion since its last probe starts the probe ladder again
    for (const id of this.#probes.keys()) {
      const t = model.threads[id];
      if (t === undefined || (t.limited === undefined && t.status === "idle")) this.#probes.delete(id);
    }
    // a refusal is remembered per limit: once the thread is limited anew (or no longer), it is forgotten
    for (const key of this.#backoff.keys()) {
      const cut = key.lastIndexOf(":");
      if (String(model.threads[key.slice(0, cut)]?.limited?.at) !== key.slice(cut + 1)) this.#backoff.delete(key);
    }
    const candidates = Object.values(model.threads)
      .flatMap((thread) => {
        const due = this.#due(thread, now);
        return due !== undefined && thread.limited !== undefined ? [{ thread, due, at: thread.limited.at }] : [];
      })
      .sort((a, b) => a.at - b.at);
    const instances = new Set<string>();
    for (const { thread, due, at } of candidates) {
      const instance = threadInstanceId(thread);
      if (instances.has(instance)) continue;
      instances.add(instance);
      const key = `${thread.id}:${at}`;
      try {
        await this.#engine.dispatch({ type: "thread.resume", threadId: thread.id, continue: true });
        this.#backoff.delete(key);
        if (due === "probe") this.#probes.set(thread.id, (this.#probes.get(thread.id) ?? 0) + 1);
        resumed.push(thread.id);
      } catch (err) {
        // busy is momentary: next tick. Anything else (a quota hold included) waits one tick, then twice as long, up to an hour
        if (err instanceof CommandError && err.code === "busy") continue;
        const previous = this.#backoff.get(key);
        const delayMs = previous === undefined ? this.#intervalMs : Math.min(previous.delayMs * 2, MAX_BACKOFF_MS);
        this.#backoff.set(key, { retryAt: now + delayMs, delayMs });
        this.#log("[limits] automatic resume refused", { threadId: thread.id, retryInMs: delayMs, err });
      }
    }
    return resumed;
  }
}
