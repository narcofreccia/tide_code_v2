import {
  newId as defaultNewId,
  type Activity,
  type EventRecord,
  type ImageInput,
  type InternalCommand,
  type NormalizedEvent,
  type Project,
  type ProviderSession,
  type SlashCommandInfo,
  type Thread,
  type TurnInput,
} from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { isUsageLimitError } from "../orchestration/limits.ts";
import { attachmentFooter } from "../workspace/attachments.ts";
import { activityKey, mergeActivity } from "./activities.ts";
import { inlinePrompt, planHandoffDelivery, type DeliveryPlan } from "./handoffDelivery.ts";
import { drainEvents, HarnessTurnQueue } from "./harnessTurns.ts";
import { instanceIdOf, type HarnessTurn, type SessionDirectory } from "./sessions.ts";

interface ThreadState {
  /** one turn at a time per thread; different threads run concurrently */
  queue: Promise<void>;
  /** `${turnId}:${driver activity key}` -> activity id, so updates land on the same row */
  activityIds: Map<string, string>;
  /** `${turnId}:${messageKey}` -> message id, so deltas assemble into one message */
  messageIds: Map<string, string>;
  /**
   * childKey -> the sub-agent's row and the turn it was launched in, kept across turns: a
   * background sub-agent reports in a later (harness-initiated) turn, and its row must settle
   * in place rather than appear twice. Its own tool rows join that turn too.
   */
  children: Map<string, { id: string; turnId: string }>;
  /** R14: idle sub-agent activity lands in arrival order (each upsert merges onto the previous one) */
  idleQueue: Promise<void>;
}

/** What one running turn learned that matters after it settles. */
interface TurnRun {
  /** the harness said the subscription window is exhausted */
  limited?: { resetsAt?: number; note?: string };
}

/** Drops every `${turnId}:…` entry of a settled turn: harness keys (request ids, tool ids) repeat across turns. */
/** The prompt text the harness gets: the typed text plus the "Attached files" footer for uploaded files. */
const textOf = (m: { text: string; attachments?: ReadonlyArray<{ mediaType: string; bytes: number; name?: string; path?: string }> }): string => m.text + attachmentFooter(m.attachments);

function dropTurnKeys(map: Map<string, string>, turnId: string): void {
  const prefix = `${turnId}:`;
  for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
}

/** Cancels a pending timer. */
export type CancelTimer = () => void;

/** The message a turn is settled with when the harness never honoured the interrupt. */
export const INTERRUPT_TIMEOUT_ERROR = "driver did not honour interrupt; session closed";

const DEFAULT_INTERRUPT_TIMEOUT_MS = 30_000;
/** how long a turn waits for the handoff judge's refine before shipping the recency selection */
export const HANDOFF_READY_WAIT_MS = 1_500;

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
  /**
   * Image bytes of a turn whose `turn.requested` this reactor never saw (a queued turn
   * promoted after a restart). The read model keeps only attachment metadata.
   */
  imagesFor?: (turnId: string) => ImageInput[] | undefined;
  /** R8: a session announced its slash commands / skills (feeds the `providers.commands` cache) */
  onCommands?: (threadId: string, commands: SlashCommandInfo[]) => void;
  /** resolves when the handoff judge is done with `handoffId` (undefined: nothing running) */
  handoffReady?: (handoffId: string) => Promise<void> | undefined;
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
  #imagesFor: ((turnId: string) => ImageInput[] | undefined) | undefined;
  #handoffReady: ((handoffId: string) => Promise<void> | undefined) | undefined;
  #onCommands: ((threadId: string, commands: SlashCommandInfo[]) => void) | undefined;
  /** turns already handed to a thread's chain (from `turn.requested` or a promotion) */
  #known = new Set<string>();
  #now: () => number;
  #newId: () => string;
  #log: (msg: string, data?: unknown) => void;
  #interruptTimeoutMs: number;
  #schedule: (fn: () => void, ms: number) => CancelTimer;
  #threads = new Map<string, ThreadState>();
  /** turnId -> watchdog cancel, armed while an interrupt is outstanding */
  #interruptTimers = new Map<string, CancelTimer>();
  /** threadId -> the turn currently inside `session.send` (the only one a steer can land in) */
  #live = new Map<string, string>();
  #inflight = new Set<Promise<unknown>>();
  /** R14: turns the harness started by itself, consumed by `#runTurn` instead of `send` */
  #harnessTurns = new HarnessTurnQueue();
  #unsubscribe: (() => void) | undefined;

  constructor(options: ReactorOptions) {
    this.#engine = options.engine;
    this.#sessions = options.sessions;
    this.#beforeTurn = options.beforeTurn;
    this.#imagesFor = options.imagesFor;
    this.#handoffReady = options.handoffReady;
    this.#onCommands = options.onCommands;
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

  /**
   * R14: the harness started a turn by itself (Claude Code resuming when a background sub-agent
   * reports). It becomes an ordinary Tide turn — a `turn.request` carrying a `harness`
   * notification — whose events are read from `turn.events` instead of a `send`.
   * Wire it as `new SessionDirectory({ ..., onHarnessTurn: (id, turn) => reactor.attachHarnessTurn(id, turn) })`.
   */
  attachHarnessTurn(threadId: string, turn: HarnessTurn): void {
    this.#harnessTurns.offer(threadId, turn);
    this.#track(
      (async () => {
        try {
          await this.#engine.dispatch({ type: "turn.request", threadId, text: turn.reason, notification: { source: "harness", summary: turn.reason } });
        } catch (err) {
          this.#log("[reactor] harness turn refused; discarding its events", err);
        }
        // still waiting = no `turn.requested` claimed it (refused, or the thread is gone)
        if (this.#harnessTurns.withdraw(threadId, turn)) await drainEvents(turn.events, this.#log);
      })(),
    );
  }

  /**
   * R14: a background sub-agent's own tool calls and progress, produced between turns. They
   * land on the sub-agent's row and the turn that launched it (no new turn is opened), keyed
   * exactly like in-turn rows so a tool's start and finish stay one row.
   * Wire it as `new SessionDirectory({ ..., onIdleActivity: (id, event) => reactor.ingestIdleActivity(id, event) })`.
   */
  ingestIdleActivity(threadId: string, event: NormalizedEvent): void {
    const state = this.#state(threadId);
    const task = async (): Promise<void> => {
      const turnId = this.#idleTurnOf(threadId, state, event);
      if (turnId === undefined) {
        this.#log("[reactor] idle activity with no turn to land on; dropped", threadId);
        return;
      }
      await this.#ingest(threadId, turnId, event, {});
    };
    state.idleQueue = state.idleQueue.then(task).catch((err: unknown) => this.#log("[reactor] idle activity failed", err));
    this.#track(state.idleQueue);
  }

  /** The turn that launched the sub-agent the event belongs to, else the thread's latest turn. */
  #idleTurnOf(threadId: string, state: ThreadState, event: NormalizedEvent): string | undefined {
    if (event.type === "activity") {
      const activity = event.activity;
      const owner = activity.kind === "child" ? state.children.get(activity.childKey) : activity.parentToolUseId ? state.children.get(activity.parentToolUseId) : undefined;
      if (owner !== undefined) return owner.turnId;
    }
    return this.#engine.getModel().threads[threadId]?.latestTurnId;
  }

  /** A harness turn that will never run: consume its events so the driver frees them. */
  async #releaseHarnessTurn(events: AsyncIterable<NormalizedEvent> | undefined, why: string, turnId: string): Promise<void> {
    if (events === undefined) return;
    this.#log(`[reactor] discarding harness turn: ${why}`, turnId);
    await drainEvents(events, this.#log);
  }

  #onRecord(record: EventRecord): void {
    const event = record.event;
    switch (event.type) {
      case "turn.requested":
        if (event.userMessage.notification?.source === "harness") this.#harnessTurns.claim(event.turn.threadId, event.turn.id);
        this.#accept(event.turn.threadId, event.turn.id, textOf(event.userMessage), event.images);
        return;
      // the harness could not take a steer: the message became a turn of its own, run like any other
      case "turn.steer-fell-back":
        this.#accept(event.threadId, event.turn.id, textOf(event.userMessage), event.images);
        return;
      case "turn.steered":
        this.#track(this.#steer(event.threadId, event.turnId, event.message.id, { text: textOf(event.message), ...(event.images && event.images.length > 0 ? { images: event.images } : {}) }));
        return;
      case "turn.dequeued":
        this.#known.delete(event.turnId);
        this.#track(this.#releaseHarnessTurn(this.#harnessTurns.take(event.turnId), "dequeued", event.turnId));
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
      case "turn.settled": {
        this.#cancelInterruptWatchdog(event.turnId);
        this.#known.delete(event.turnId);
        const state = this.#threads.get(event.threadId);
        if (state) {
          dropTurnKeys(state.activityIds, event.turnId);
          dropTurnKeys(state.messageIds, event.turnId);
        }
        this.#runPromoted(event.threadId, event.turnId);
        return;
      }
      default:
        return;
    }
  }

  /** Queued turns ride the same per-thread chain: they start when the running one settles. */
  #accept(threadId: string, turnId: string, text: string, images: ImageInput[] | undefined): void {
    const input: TurnInput = { text, ...(images ? { images } : {}) };
    this.#known.add(turnId);
    this.#enqueue(threadId, () => this.#runTurn(threadId, turnId, input));
  }

  /**
   * Out-of-band like approvals: the message goes into the turn `send` is running right now. Any
   * reason it cannot (no live turn on this reactor, no cap, the harness refused) is reported as
   * `steer.fallback`, and the decider turns the message into a queued turn.
   */
  async #steer(threadId: string, turnId: string, messageId: string, input: TurnInput): Promise<void> {
    const fallback = (reason: string): Promise<void> => this.#dispatch({ type: "steer.fallback", messageId, reason });
    const session = this.#sessions.peek(threadId);
    const thread = this.#engine.getModel().threads[threadId];
    if (!session || !thread || this.#live.get(threadId) !== turnId) return fallback("no turn is running on the harness");
    let steerable = false;
    try {
      steerable = (await this.#sessions.caps(instanceIdOf(thread))).steer === true && session.steer !== undefined;
    } catch (err) {
      this.#log("[reactor] could not read driver caps", err);
    }
    if (!steerable) return fallback(`${thread.provider} cannot take a message into a running turn`);
    try {
      await session.steer!(input);
      this.#sessions.touch(threadId);
    } catch (err) {
      this.#log("[reactor] steer refused", err);
      await fallback(`the harness refused the message: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The projector promotes the oldest queued turn when the live one settles. Normally that turn
   * is already waiting on this thread's chain; after a restart (recovery settled the dead turn)
   * nobody queued it, so it is picked up here from the read model.
   */
  #runPromoted(threadId: string, settledTurnId: string): void {
    const next = this.#engine.getModel().threads[threadId]?.latestTurnId;
    if (next === undefined || next === settledTurnId) return;
    this.resume(threadId, next);
  }

  /** Runs a `requested` turn this reactor never saw requested (promoted after a restart, or left unsent by a graceful shutdown). */
  resume(threadId: string, next: string): void {
    const model = this.#engine.getModel();
    if (this.#known.has(next)) return;
    if (model.threads[threadId]?.latestTurnId !== next || model.turns[next]?.status !== "requested") return;
    const message = (model.threadMessages[threadId] ?? []).map((id) => model.messages[id]).find((m) => m?.turnId === next && m.role === "user");
    const images = this.#imagesFor?.(next);
    const input: TurnInput = { text: message !== undefined ? textOf(message) : "", ...(images !== undefined && images.length > 0 ? { images } : {}) };
    this.#known.add(next);
    this.#enqueue(threadId, () => this.#runTurn(threadId, next, input));
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
      state = { queue: Promise.resolve(), activityIds: new Map(), messageIds: new Map(), children: new Map(), idleQueue: Promise.resolve() };
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

  async #runTurn(threadId: string, turnId: string, input: TurnInput): Promise<void> {
    // a turn the harness is already running: its events replace `send`, no prompt is built
    const attached = this.#harnessTurns.take(turnId);
    // dequeued while waiting, or settled by recovery/shutdown: nothing to run
    if (this.#engine.getModel().turns[turnId]?.status !== "requested") return this.#releaseHarnessTurn(attached, "turn no longer requested", turnId);
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
      return this.#releaseHarnessTurn(attached, "thread or project is gone", turnId);
    }

    let started = false;
    const start = async (nativeSessionId?: string, modelId?: string): Promise<void> => {
      if (started) return;
      started = true;
      await this.#dispatch({
        type: "turn.start",
        turnId,
        provider: thread.provider,
        ...(thread.providerId !== undefined ? { providerId: thread.providerId } : {}),
        ...((modelId ?? thread.model) !== undefined ? { model: modelId ?? thread.model } : {}),
        ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
      });
    };

    let settled = false;
    const run: TurnRun = {};
    try {
      // an attached turn never opens/reconfigures: that could close the very session running it
      const opened = attached === undefined ? await this.#openFor(thread, project, turnId, input) : undefined;
      this.#sessions.touch(threadId);
      const nativeSessionId = (opened?.session ?? this.#sessions.peek(threadId))?.nativeSessionId;
      if (nativeSessionId !== undefined) await start(nativeSessionId);
      this.#live.set(threadId, turnId);
      const events = opened !== undefined ? opened.session.send(opened.prompt) : attached!;
      for await (const event of events) {
        // every sign of life keeps the session off the idle reaper
        this.#sessions.touch(threadId);
        if (event.type === "session") {
          await start(event.nativeSessionId, event.model);
          continue;
        }
        await start();
        if (await this.#ingest(threadId, turnId, event, run)) settled = true;
      }
      if (!settled) {
        await start();
        await this.#dispatch({ type: "turn.settle", turnId, status: "completed" });
        settled = true;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log("[reactor] driver error", err);
      if (!settled) {
        await start();
        await this.#dispatch({ type: "activity.upsert", activity: this.#errorActivity(threadId, turnId, message) });
        await this.#dispatch({ type: "turn.settle", turnId, status: "error", error: message });
        settled = true;
        if (isUsageLimitError(message)) run.limited ??= { note: message };
      }
    } finally {
      if (this.#live.get(threadId) === turnId) this.#live.delete(threadId);
    }
    if (settled && run.limited !== undefined) {
      await this.#dispatch({
        type: "thread.limited",
        threadId,
        ...(run.limited.resetsAt !== undefined ? { resetsAt: run.limited.resetsAt } : {}),
        ...(run.limited.note !== undefined ? { note: run.limited.note } : {}),
      });
    }
  }

  /**
   * Gets the thread's session and the prompt to send. A turn carrying a handoff is delivered
   * natively when the harness can fork its source session (then `rollback` trims the turns after
   * the fork point), otherwise the history goes inline ahead of the user's text.
   */
  async #openFor(thread: Thread, project: Project, turnId: string, input: TurnInput): Promise<{ session: ProviderSession; prompt: TurnInput }> {
    const handoffId = this.#engine.getModel().turns[turnId]?.handoffId;
    if (handoffId !== undefined) await this.#awaitHandoff(handoffId);
    const model = this.#engine.getModel();
    const hasHandoff = handoffId !== undefined;
    let plan: DeliveryPlan | undefined;
    if (hasHandoff) {
      let caps = {};
      try {
        caps = await this.#sessions.caps(instanceIdOf(thread));
      } catch (err) {
        this.#log("[reactor] could not read driver caps", err);
      }
      plan = planHandoffDelivery(model, thread, turnId, caps);
    }
    if (plan === undefined) return { session: await this.#sessions.getOrOpen(thread, project), prompt: input };
    let delivery = plan.delivery;
    let session: ProviderSession | undefined;
    // a live session (should not exist on a fork's first turn) would ignore the fork request
    if (plan.delivery === "native" && this.#sessions.peek(thread.id) === undefined) {
      const { forkFrom, rollback } = plan;
      try {
        session = await this.#sessions.getOrOpen(thread, project, { forkFrom });
        if (rollback > 0) {
          if (session.rollback === undefined) throw new Error(`${thread.provider} driver does not implement rollback`);
          await session.rollback(rollback);
        }
      } catch (err) {
        this.#log("[reactor] native fork failed; delivering the handoff inline", err);
        await this.#sessions.close(thread.id);
        session = undefined;
        delivery = "inline";
      }
    } else delivery = "inline";
    session ??= await this.#sessions.getOrOpen(thread, project);
    await this.#dispatch({ type: "handoff.delivered", turnId, delivery });
    // re-read: a refine that landed while the session opened is the text to ship (later ones are refused)
    const handoff = this.#engine.getModel().handoffs[plan.handoff.id] ?? plan.handoff;
    return { session, prompt: delivery === "native" ? input : { ...input, text: inlinePrompt(handoff, input.text) } };
  }

  /** Gives the handoff judge a short window to refine the selection; never blocks a turn longer. */
  async #awaitHandoff(handoffId: string): Promise<void> {
    let ready: Promise<void> | undefined;
    try {
      ready = this.#handoffReady?.(handoffId);
    } catch (err) {
      this.#log("[reactor] handoffReady failed", err);
    }
    if (ready === undefined) return;
    let cancel: CancelTimer | undefined;
    const timeout = new Promise<void>((resolve) => {
      cancel = this.#schedule(resolve, HANDOFF_READY_WAIT_MS);
    });
    try {
      await Promise.race([ready.catch(() => undefined), timeout]);
    } finally {
      cancel?.();
    }
  }

  #errorActivity(threadId: string, turnId: string, text: string): Activity {
    const at = this.#now();
    return { id: this.#newId(), threadId, turnId, kind: "error", text, createdAt: at, updatedAt: at };
  }

  /** Translates one NormalizedEvent into internal commands; true when the turn settled. */
  async #ingest(threadId: string, turnId: string, event: NormalizedEvent, run: TurnRun): Promise<boolean> {
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
      case "assistant.reasoning": {
        const key = `${turnId}:${event.messageKey}`;
        let messageId = state.messageIds.get(key);
        if (messageId === undefined) {
          messageId = this.#newId();
          state.messageIds.set(key, messageId);
        }
        await this.#dispatch({ type: "assistant.reasoning.append", turnId, messageId, delta: event.delta });
        return false;
      }
      case "activity": {
        // scoped to the turn: Codex request ids restart at 0 per process, tool ids may repeat
        const native = activityKey(event.activity);
        const key = native === undefined ? undefined : `${turnId}:${native}`;
        const child = event.activity.kind === "child" ? state.children.get(event.activity.childKey) : undefined;
        const parentKey = event.activity.kind === "child" ? undefined : event.activity.parentToolUseId ?? undefined;
        const parent = parentKey === undefined ? undefined : state.children.get(parentKey);
        let id = event.activity.id ?? child?.id ?? (key !== undefined ? state.activityIds.get(key) : undefined);
        id ??= this.#newId();
        if (key !== undefined) state.activityIds.set(key, id);
        // a child settling later lands on its own row and turn; its tool rows follow it
        const ownerTurnId = child?.turnId ?? parent?.turnId ?? turnId;
        if (event.activity.kind === "child" && child === undefined) state.children.set(event.activity.childKey, { id, turnId });
        const at = this.#now();
        const previous = this.#engine.getModel().activities[id];
        const activity = mergeActivity(previous, event.activity, { id, threadId, turnId: ownerTurnId, createdAt: at, updatedAt: at });
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
        if (event.rateLimit?.status === "limited") {
          run.limited = {
            ...(event.rateLimit.resetsAt !== undefined ? { resetsAt: event.rateLimit.resetsAt } : {}),
            ...(event.rateLimit.note !== undefined ? { note: event.rateLimit.note } : {}),
          };
        }
        await this.#dispatch({
          type: "usage.report",
          turnId,
          ...(event.usage !== undefined ? { usage: event.usage } : {}),
          ...(event.contextUsage !== undefined ? { contextUsage: event.contextUsage } : {}),
          ...(event.rateLimit !== undefined ? { rateLimit: event.rateLimit } : {}),
        });
        return false;
      case "commands":
        this.#onCommands?.(threadId, event.commands);
        return false;
      case "settled":
        if (event.status === "error" && isUsageLimitError(event.error)) run.limited ??= { note: event.error as string };
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
