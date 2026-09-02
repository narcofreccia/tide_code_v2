import {
  newId as defaultNewId,
  type Activity,
  type EventRecord,
  type InternalCommand,
  type NormalizedEvent,
  type ProviderSession,
} from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { activityKey, mergeActivity } from "./activities.ts";
import type { SessionDirectory } from "./sessions.ts";

interface ThreadState {
  /** one turn at a time per thread; different threads run concurrently */
  queue: Promise<void>;
  /** driver activity key -> activity id, so updates land on the same row */
  activityIds: Map<string, string>;
  /** `${turnId}:${messageKey}` -> message id, so deltas assemble into one message */
  messageIds: Map<string, string>;
}

/** Cancels a pending timer. */
export type CancelTimer = () => void;

/** The message a turn is settled with when the harness never honoured the interrupt. */
export const INTERRUPT_TIMEOUT_ERROR = "driver did not honour interrupt; session closed";

const DEFAULT_INTERRUPT_TIMEOUT_MS = 30_000;

const realTimer = (fn: () => void, ms: number): CancelTimer => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export interface ReactorOptions {
  engine: Engine;
  sessions: SessionDirectory;
  /** awaited before the harness is handed the prompt (P2: the vcs before-checkpoint) */
  beforeTurn?: (threadId: string, turnId: string) => Promise<void>;
  /** grace period a driver gets to honour an interrupt before the turn is force-settled */
  interruptTimeoutMs?: number;
  /** injectable clock so tests drive the interrupt watchdog by hand instead of sleeping */
  schedule?: (fn: () => void, ms: number) => CancelTimer;
  now?: () => number;
  newId?: () => string;
  log?: (msg: string, data?: unknown) => void;
}

/**
 * Bridges the event log and the provider drivers: turns requested by the engine are
 * run on a session, and every NormalizedEvent comes back as an internal command.
 * The reactor holds no business rules — the decider still owns every transition.
 */
export class ProviderReactor {
  #engine: Engine;
  #sessions: SessionDirectory;
  #beforeTurn: ((threadId: string, turnId: string) => Promise<void>) | undefined;
  #now: () => number;
  #newId: () => string;
  #log: (msg: string, data?: unknown) => void;
  #interruptTimeoutMs: number;
  #schedule: (fn: () => void, ms: number) => CancelTimer;
  #threads = new Map<string, ThreadState>();
  /** turnId -> watchdog cancel, armed while an interrupt is outstanding */
  #interruptTimers = new Map<string, CancelTimer>();
  #inflight = new Set<Promise<unknown>>();
  #unsubscribe: (() => void) | undefined;

  constructor(options: ReactorOptions) {
    this.#engine = options.engine;
    this.#sessions = options.sessions;
    this.#beforeTurn = options.beforeTurn;
    this.#interruptTimeoutMs = options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
    this.#schedule = options.schedule ?? realTimer;
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => defaultNewId());
    this.#log = options.log ?? ((msg, data) => (data === undefined ? console.error(msg) : console.error(msg, data)));
  }

  start(): void {
    this.#unsubscribe ??= this.#engine.subscribe((record) => this.#onRecord(record));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const cancel of this.#interruptTimers.values()) cancel();
    this.#interruptTimers.clear();
  }

  /** Resolves when the engine is drained and no turn or driver call is in flight. */
  async drain(): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      await this.#engine.drain();
      if (this.#inflight.size === 0) {
        await this.#engine.drain();
        if (this.#inflight.size === 0) return;
        continue;
      }
      await Promise.allSettled([...this.#inflight]);
    }
    throw new Error("reactor did not drain");
  }

  #onRecord(record: EventRecord): void {
    const event = record.event;
    switch (event.type) {
      case "turn.requested":
        this.#enqueue(event.turn.threadId, () =>
          this.#runTurn(event.turn.threadId, event.turn.id, event.userMessage.text),
        );
        return;
      case "approval.responded":
        this.#withSession(
          event.threadId,
          (s) => s.respondApproval(event.requestId, event.decision),
          () => this.#sessionGone(event.threadId),
        );
        return;
      case "user-input.responded":
        this.#withSession(
          event.threadId,
          (s) => s.respondUserInput(event.requestId, event.answers),
          () => this.#sessionGone(event.threadId),
        );
        return;
      case "turn.interrupt-requested":
        this.#withSession(event.threadId, (s) => s.interrupt());
        this.#armInterruptWatchdog(event.threadId, event.turnId);
        return;
      case "turn.settled":
        this.#cancelInterruptWatchdog(event.turnId);
        return;
      default:
        return;
    }
  }

  // ---- interrupt watchdog ----

  /**
   * A harness may swallow an interrupt (crashed, wedged, protocol gap). Rather than leave the
   * thread stuck on `running`/`interrupting` forever, the reactor gives it a grace period and
   * then settles the turn itself and drops the session, which the next turn reopens.
   */
  #armInterruptWatchdog(threadId: string, turnId: string): void {
    this.#cancelInterruptWatchdog(turnId);
    this.#interruptTimers.set(
      turnId,
      this.#schedule(() => {
        this.#interruptTimers.delete(turnId);
        this.#track(this.#forceInterrupt(threadId, turnId));
      }, this.#interruptTimeoutMs),
    );
  }

  #cancelInterruptWatchdog(turnId: string): void {
    const cancel = this.#interruptTimers.get(turnId);
    if (cancel === undefined) return;
    this.#interruptTimers.delete(turnId);
    cancel();
  }

  async #forceInterrupt(threadId: string, turnId: string): Promise<void> {
    const turn = this.#engine.getModel().turns[turnId];
    if (turn === undefined || turn.settledAt !== undefined) return;
    this.#log("[reactor] driver ignored the interrupt; settling the turn and closing the session", { threadId, turnId });
    await this.#dispatch({ type: "turn.settle", turnId, status: "interrupted", error: INTERRUPT_TIMEOUT_ERROR });
    try {
      await this.#sessions.close(threadId);
    } catch (err) {
      this.#log("[reactor] session close failed", err);
    }
  }

  #state(threadId: string): ThreadState {
    let state = this.#threads.get(threadId);
    if (!state) {
      state = { queue: Promise.resolve(), activityIds: new Map(), messageIds: new Map() };
      this.#threads.set(threadId, state);
    }
    return state;
  }

  #track(promise: Promise<unknown>): void {
    const tracked = promise.finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
  }

  #enqueue(threadId: string, task: () => Promise<void>): void {
    const state = this.#state(threadId);
    state.queue = state.queue.then(task).catch((err: unknown) => this.#log("[reactor] turn failed", err));
    this.#track(state.queue);
  }

  /**
   * The projector resolves an approval/answer as soon as the user responds, so a response the
   * harness never receives would leave the UI reporting success while nothing happened. The
   * turn is settled with an error instead, and the user is told to start a new one.
   */
  async #sessionGone(threadId: string): Promise<void> {
    const model = this.#engine.getModel();
    const turnId = model.threads[threadId]?.latestTurnId;
    if (turnId === undefined) return;
    const text = "the harness session is gone; start a new turn";
    await this.#dispatch({ type: "activity.upsert", activity: this.#errorActivity(threadId, turnId, text) });
    if (model.turns[turnId]?.settledAt !== undefined) return;
    await this.#dispatch({ type: "turn.settle", turnId, status: "error", error: text });
  }

  /** Out-of-band driver calls: they must not wait behind the running turn. */
  #withSession(threadId: string, call: (session: ProviderSession) => Promise<void>, onMissing?: () => Promise<void>): void {
    const session = this.#sessions.peek(threadId);
    if (!session) {
      this.#log("[reactor] no live session for thread", threadId);
      if (onMissing) this.#track(onMissing());
      return;
    }
    this.#track(
      (async () => {
        try {
          await call(session);
        } catch (err) {
          this.#log("[reactor] driver call failed", err);
        }
      })(),
    );
  }

  async #dispatch(command: InternalCommand): Promise<void> {
    try {
      await this.#engine.dispatch(command);
    } catch (err) {
      this.#log(`[reactor] ${command.type} rejected`, err);
    }
  }

  async #runTurn(threadId: string, turnId: string, text: string): Promise<void> {
    // Gives the vcs reactor its window to snapshot the working tree before the first tool
    // call, and to attach a worktree, so the session below opens in the final cwd.
    if (this.#beforeTurn) {
      try {
        await this.#beforeTurn(threadId, turnId);
      } catch (err) {
        this.#log("[reactor] beforeTurn hook failed", err);
      }
    }
    const model = this.#engine.getModel();
    const thread = model.threads[threadId];
    const project = thread ? model.projects[thread.projectId] : undefined;
    if (!thread || !project) {
      await this.#dispatch({ type: "turn.settle", turnId, status: "error", error: "thread or project is gone" });
      return;
    }

    let started = false;
    const start = async (nativeSessionId?: string, modelId?: string): Promise<void> => {
      if (started) return;
      started = true;
      await this.#dispatch({
        type: "turn.start",
        turnId,
        provider: thread.provider,
        ...((modelId ?? thread.model) !== undefined ? { model: modelId ?? thread.model } : {}),
        ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
      });
    };

    let settled = false;
    try {
      const session = await this.#sessions.getOrOpen(thread, project);
      if (session.nativeSessionId !== undefined) await start(session.nativeSessionId);
      for await (const event of session.send({ text })) {
        if (event.type === "session") {
          await start(event.nativeSessionId, event.model);
          continue;
        }
        await start();
        if (await this.#ingest(threadId, turnId, event)) settled = true;
      }
      if (!settled) {
        await start();
        await this.#dispatch({ type: "turn.settle", turnId, status: "completed" });
        settled = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log("[reactor] driver error", err);
      if (settled) return;
      await start();
      await this.#dispatch({ type: "activity.upsert", activity: this.#errorActivity(threadId, turnId, message) });
      await this.#dispatch({ type: "turn.settle", turnId, status: "error", error: message });
    }
  }

  #errorActivity(threadId: string, turnId: string, text: string): Activity {
    const at = this.#now();
    return { id: this.#newId(), threadId, turnId, kind: "error", text, createdAt: at, updatedAt: at };
  }

  /** Translates one NormalizedEvent into internal commands; true when the turn settled. */
  async #ingest(threadId: string, turnId: string, event: NormalizedEvent): Promise<boolean> {
    const state = this.#state(threadId);
    switch (event.type) {
      case "assistant.delta": {
        const key = `${turnId}:${event.messageKey}`;
        let messageId = state.messageIds.get(key);
        if (messageId === undefined) {
          messageId = this.#newId();
          state.messageIds.set(key, messageId);
        }
        await this.#dispatch({ type: "assistant.append", turnId, messageId, delta: event.delta });
        return false;
      }
      case "activity": {
        const key = activityKey(event.activity);
        let id = event.activity.id ?? (key !== undefined ? state.activityIds.get(key) : undefined);
        id ??= this.#newId();
        if (key !== undefined) state.activityIds.set(key, id);
        const at = this.#now();
        const previous = this.#engine.getModel().activities[id];
        const activity = mergeActivity(previous, event.activity, { id, threadId, turnId, createdAt: at, updatedAt: at });
        await this.#dispatch({ type: "activity.upsert", activity });
        return false;
      }
      case "plan.proposed":
        await this.#dispatch({ type: "plan.propose", turnId, markdown: event.markdown });
        return false;
      case "plan.progress":
        await this.#dispatch({ type: "plan.progress", threadId, steps: event.steps });
        return false;
      case "usage":
        await this.#dispatch({
          type: "usage.report",
          turnId,
          ...(event.usage !== undefined ? { usage: event.usage } : {}),
          ...(event.contextUsage !== undefined ? { contextUsage: event.contextUsage } : {}),
        });
        return false;
      case "settled":
        await this.#dispatch({
          type: "turn.settle",
          turnId,
          status: event.status,
          ...(event.error !== undefined ? { error: event.error } : {}),
        });
        return true;
      default:
        return false;
    }
  }
}
