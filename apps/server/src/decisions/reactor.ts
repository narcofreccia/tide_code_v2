import type { EventRecord } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import type { CancelTimer } from "../provider/reactor.ts";
import { OVER_BUDGET, type Judge } from "./judge.ts";
import { backgroundActivityAt } from "../orchestration/background.ts";
import { buildTriageQuestion, lastActivityAt, mapAnswers } from "./triage.ts";

export const DEBOUNCE_MS = 2_000;
export const TICK_MS = 10 * 60_000;
export const STALE_RUNNING_MS = 10 * 60_000;
export const ERROR_LOG_INTERVAL_MS = 5 * 60_000;

const realTimer = (fn: () => void, ms: number): CancelTimer => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export interface TriageReactorOptions {
  engine: Engine;
  judge: Pick<Judge, "ask" | "enabled">;
  schedule?: (fn: () => void, ms: number) => CancelTimer;
  now?: () => number;
  log?: (msg: string, data?: unknown) => void;
}

/**
 * Annotates threads with calibrated triage (needs-user / stuck / urgency) from the optional
 * judge (site `stuck`) so the Inbox can sort. It only dispatches `thread.triage`; it never routes,
 * blocks or acts, and it never throws into the engine. One judge question per project per burst;
 * the judge packs it into as few calls as fit, and a failed call costs only its own threads.
 */
export class TriageReactor {
  #engine: Engine;
  #judge: TriageReactorOptions["judge"];
  #schedule: (fn: () => void, ms: number) => CancelTimer;
  #now: () => number;
  #log: (msg: string, data?: unknown) => void;
  #unsubscribe: (() => void) | undefined;
  #tick: CancelTimer | undefined;
  #debounce = new Map<string, CancelTimer>();
  #chains = new Map<string, Promise<void>>();
  #inflight = new Set<Promise<unknown>>();
  #lastErrorLog = Number.NEGATIVE_INFINITY;

  constructor(options: TriageReactorOptions) {
    this.#engine = options.engine;
    this.#judge = options.judge;
    this.#schedule = options.schedule ?? realTimer;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((msg, data) => (data === undefined ? console.error(msg) : console.error(msg, data)));
  }

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#engine.subscribe((record) => this.#onRecord(record));
    this.#armTick();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#tick?.();
    this.#tick = undefined;
    for (const cancel of this.#debounce.values()) cancel();
    this.#debounce.clear();
  }

  /** Resolves when the engine is drained and no triage request is in flight (pending debounce timers are not waited for). */
  async drain(): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      await this.#engine.drain();
      if (this.#inflight.size === 0) return;
      await Promise.allSettled([...this.#inflight]);
    }
    throw new Error("triage reactor did not drain");
  }

  #armTick(): void {
    this.#tick = this.#schedule(() => {
      this.#armTick();
      this.#staleSweep();
    }, TICK_MS);
  }

  /**
   * Working threads with no event for 10 min: ask again, they may be stuck. A thread whose turn
   * settled while background sub-agents still run is working too; it is re-asked only when none
   * of those agents produced anything (their row or a tool call of theirs) for the same 10 min.
   * Background agents emit a row per tool call, so that long a silence is the same signal as a
   * silent foreground turn. While they are active the thread is never a stale candidate.
   */
  #staleSweep(): void {
    const model = this.#engine.getModel();
    const now = this.#now();
    for (const t of Object.values(model.threads)) {
      if (t.archivedAt !== undefined) continue;
      const running = t.status === "running" && now - lastActivityAt(model, t) >= STALE_RUNNING_MS;
      const backgroundAt = t.status === "running" ? undefined : backgroundActivityAt(model, t.id);
      const silentBackground = backgroundAt !== undefined && now - backgroundAt >= STALE_RUNNING_MS;
      if (running || silentBackground) this.#trigger(t.projectId);
    }
  }

  #onRecord(record: EventRecord): void {
    try {
      const event = record.event;
      let threadId: string | undefined;
      if (event.type === "turn.settled") threadId = event.threadId;
      else if (event.type === "plan.proposed") threadId = event.plan.threadId;
      else if (event.type === "activity.upserted" && (event.activity.kind === "approval" || event.activity.kind === "user-input") && event.activity.status === "pending") threadId = event.activity.threadId;
      if (threadId === undefined) return;
      const projectId = this.#engine.getModel().threads[threadId]?.projectId;
      if (projectId !== undefined) this.#trigger(projectId);
    } catch (err) {
      this.#logOnce("[triage] trigger failed", err);
    }
  }

  /** Trailing debounce per project: a burst of triggers becomes one request. */
  #trigger(projectId: string): void {
    if (!this.#judge.enabled("stuck")) return;
    this.#debounce.get(projectId)?.();
    this.#debounce.set(
      projectId,
      this.#schedule(() => {
        this.#debounce.delete(projectId);
        this.#enqueue(projectId);
      }, DEBOUNCE_MS),
    );
  }

  /** One run at a time per project. */
  #enqueue(projectId: string): void {
    const chain = (this.#chains.get(projectId) ?? Promise.resolve()).then(() => this.#run(projectId)).catch((err: unknown) => this.#logOnce("[triage] run failed", err));
    this.#chains.set(projectId, chain);
    const tracked = chain.finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
  }

  async #run(projectId: string): Promise<void> {
    if (!this.#judge.enabled("stuck")) return;
    const triage = buildTriageQuestion(this.#engine.getModel(), projectId, this.#now());
    if (triage === undefined) return;
    const verdicts = await this.#judge.ask(triage.question);
    const failed = verdicts.find((v) => v.error !== undefined && v.error !== OVER_BUDGET && v.source === "none");
    if (failed !== undefined) this.#logOnce("[triage] decisions request failed", failed.error);
    for (const [threadId, result] of mapAnswers(triage, verdicts, this.#now())) {
      try {
        await this.#engine.dispatch({ type: "thread.triage", threadId, triage: result });
      } catch (err) {
        this.#logOnce("[triage] thread.triage rejected", err);
      }
    }
  }

  #logOnce(msg: string, data: unknown): void {
    const now = this.#now();
    if (now - this.#lastErrorLog < ERROR_LOG_INTERVAL_MS) return;
    this.#lastErrorLog = now;
    this.#log(msg, data);
  }
}
