import type { ScheduledTask } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import type { SettingsStore } from "../settings.ts";
import { nextFireAt } from "./schedule.ts";

export const SCHEDULER_TICK_MS = 5_000;

export type CancelTimer = () => void;

export interface SchedulerOptions {
  engine: Engine;
  settings?: Pick<SettingsStore, "get">;
  now?: () => number;
  /** repeating timer; returns its canceller */
  schedule?: (fn: () => void, ms: number) => CancelTimer;
  tickMs?: number;
  log?: (msg: string, data?: unknown) => void;
}

const realInterval = (fn: () => void, ms: number): CancelTimer => {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

/**
 * Watches the clock and dispatches `task.fire` for due tasks. The decider owns what a fire means;
 * the commandId `scheduled:<task>:<nextRunAt>` makes a repeated tick (or a restart) a receipt replay.
 * Missed fixed slots are skipped and an overdue interval fires once, both because the next slot is
 * computed from `now`.
 */
export class Scheduler {
  #engine: Engine;
  #settings: Pick<SettingsStore, "get"> | undefined;
  #now: () => number;
  #schedule: (fn: () => void, ms: number) => CancelTimer;
  #tickMs: number;
  #log: (msg: string, data?: unknown) => void;
  #cancel: CancelTimer | undefined;
  #inflight: Promise<unknown> = Promise.resolve();
  /** commandIds the engine rejected: not retried until the task's nextRunAt changes */
  #skipped = new Set<string>();

  constructor(options: SchedulerOptions) {
    this.#engine = options.engine;
    this.#settings = options.settings;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule = options.schedule ?? realInterval;
    this.#tickMs = options.tickMs ?? SCHEDULER_TICK_MS;
    this.#log = options.log ?? (() => undefined);
  }

  start(): void {
    if (this.#cancel) return;
    this.#cancel = this.#schedule(() => {
      this.#inflight = this.tick().catch((err) => this.#log("[scheduler] tick failed", err));
    }, this.#tickMs);
  }

  stop(): void {
    this.#cancel?.();
    this.#cancel = undefined;
  }

  /** resolves once the tick in flight (if any) has finished */
  async drain(): Promise<void> {
    await this.#inflight;
  }

  /** One pass over the read model; returns the task ids fired. */
  async tick(): Promise<string[]> {
    const now = this.#now();
    const fired: string[] = [];
    const due = Object.values(this.#engine.getModel().scheduledTasks).filter(
      (t): t is ScheduledTask & { nextRunAt: number } =>
        t.enabled && t.archivedAt === undefined && t.nextRunAt !== undefined && t.nextRunAt <= now,
    );
    for (const task of due) {
      const commandId = `scheduled:${task.id}:${task.nextRunAt}`;
      if (this.#skipped.has(commandId)) continue;
      const next = nextFireAt(task.schedule, now);
      try {
        const result = await this.#engine.dispatch({
          type: "task.fire",
          commandId,
          taskId: task.id,
          ...(next !== undefined ? { nextRunAt: next } : {}),
          useWorktreeDefault: this.#settings?.get().worktreeByDefault ?? true,
        });
        if (result.events.length > 0) fired.push(task.id);
      } catch (err) {
        this.#skipped.add(commandId);
        this.#log(`[scheduler] fire of task ${task.id} rejected`, err);
      }
    }
    return fired;
  }
}
