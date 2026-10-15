import type { Engine } from "./engine.ts";

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

const realTimer = (fn: () => void, ms: number): CancelTimer => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Wakes limited threads whose policy is "resume at reset" once the harness's window reopens.
 * The decider owns what a resume means (`thread.resume { continue }`); this only watches the clock.
 * A snooze needs nothing: the UI stops hiding the thread once `snoozedUntil` has passed.
 */
export class LimitsWorker {
  #engine: Engine;
  #now: () => number;
  #schedule: (fn: () => void, ms: number) => CancelTimer;
  #intervalMs: number;
  #log: (msg: string, data?: unknown) => void;
  #cancel: CancelTimer | undefined;
  #running = false;
  /** `${threadId}:${limited.at}` whose resume was refused: retried only when the thread is limited anew */
  #refused = new Set<string>();

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

  /** One pass over the read model; exposed so tests drive it without a timer. */
  async tick(): Promise<string[]> {
    const now = this.#now();
    const resumed: string[] = [];
    for (const thread of Object.values(this.#engine.getModel().threads)) {
      const limited = thread.limited;
      if (limited?.resume !== "reset" || limited.resetsAt === undefined || limited.resetsAt > now) continue;
      if (thread.archivedAt !== undefined || thread.status === "running") continue;
      const key = `${thread.id}:${limited.at}`;
      if (this.#refused.has(key)) continue;
      try {
        await this.#engine.dispatch({ type: "thread.resume", threadId: thread.id, continue: true });
        resumed.push(thread.id);
      } catch (err) {
        this.#refused.add(key);
        this.#log("[limits] automatic resume refused", { threadId: thread.id, err });
      }
    }
    return resumed;
  }
}
