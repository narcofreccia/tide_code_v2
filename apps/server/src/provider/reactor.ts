import {
  newId as defaultNewId,
  type Activity,
  type Command,
  type EventRecord,
  type ImageInput,
  type InternalCommand,
  type NormalizedEvent,
  type ProviderSession,
  type SlashCommandInfo,
  type TurnInput,
} from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { isSecretResponse } from "./secretInput.ts";
import { redactSecretTool, secretValuesFor, type SecretValues } from "./secretRedaction.ts";
import { isUsageLimitError } from "../orchestration/limits.ts";
import { activityKey, mergeActivity } from "./activities.ts";
import { isRedundantGauge, knownGauge } from "./gauges.ts";
import { dropTurnKeys, newThreadState, realTimer, storedInput, textOf, type ThreadState, type TurnRun } from "./turnState.ts";
import { openTurn, type CancelTimer, type OpenTurnDeps } from "./openTurn.ts";
import { ownerChildRow, rememberChild } from "./children.ts";
import { dismissHarnessTurn, HarnessTurnQueue, SteerRetargets } from "./harnessTurns.ts";
import { instanceIdOf, type HarnessTurn, type SessionDirectory } from "./sessions.ts";
import { resumeLostActivity, resumeRefusedRow, startCommand, type ResumeLoss } from "./sessionNotices.ts";

export { HANDOFF_READY_WAIT_MS, type CancelTimer } from "./openTurn.ts";

/** The message a turn is settled with when the harness never honoured the interrupt. */
export const INTERRUPT_TIMEOUT_ERROR = "driver did not honour interrupt; session closed";

const DEFAULT_INTERRUPT_TIMEOUT_MS = 30_000;

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
  /** R18: values handed to agents, scrubbed from every command (default: the engine's registry) */
  secrets?: SecretValues;
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
  #open: OpenTurnDeps;
  #onCommands: ((threadId: string, commands: SlashCommandInfo[]) => void) | undefined;
  #secrets: SecretValues;
  /** turns already handed to a thread's chain (from `turn.requested` or a promotion) */
  #known = new Set<string>();
  /** R20: queued turns whose chain task found them still queued (held), until a release runs them */
  #held = new Map<string, TurnInput>();
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
  /** threadId -> the driver's key of the live turn, when it is a harness turn (steers name it) */
  #liveKey = new Map<string, string>();
  /** R14: steers refused because the harness moved on to its next turn, re-aimed at that turn */
  #retargets = new SteerRetargets();
  #inflight = new Set<Promise<unknown>>();
  /** R14: turns the harness started by itself, consumed by `#runTurn` instead of `send` */
  #harnessTurns = new HarnessTurnQueue();
  #unsubscribe: (() => void) | undefined;

  constructor(options: ReactorOptions) {
    this.#engine = options.engine;
    this.#sessions = options.sessions;
    this.#beforeTurn = options.beforeTurn;
    this.#imagesFor = options.imagesFor;
    this.#onCommands = options.onCommands;
    this.#secrets = options.secrets ?? secretValuesFor(options.engine);
    this.#interruptTimeoutMs = options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS;
    this.#schedule = options.schedule ?? realTimer;
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => defaultNewId());
    this.#log = options.log ?? ((msg, data) => (data === undefined ? console.error(msg) : console.error(msg, data)));
    this.#open = { engine: this.#engine, sessions: this.#sessions, handoffReady: options.handoffReady, schedule: this.#schedule, dispatch: (c) => this.#dispatch(c), log: this.#log };
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
    // C4: a driver that does not declare `harnessTurns` never gets to open a turn of its own
    const declared = this.#sessions.declaresHarnessTurns(threadId);
    if (declared === false) {
      this.#track(this.#releaseHarnessTurn(turn, "driver does not declare harnessTurns", threadId));
      return;
    }
    this.#harnessTurns.offer(threadId, turn);
    this.#track(
      (async () => {
        try {
          if (declared === undefined && !(await this.#harnessTurnsDeclared(threadId))) throw new Error("driver does not declare harnessTurns");
          await this.#engine.dispatch({ type: "turn.request", threadId, text: turn.reason, notification: { source: "harness", summary: turn.reason } });
        } catch (err) {
          this.#log("[reactor] harness turn refused; discarding its events", err);
        }
        // still waiting = no `turn.requested` claimed it (refused, or the thread is gone)
        if (this.#harnessTurns.withdraw(threadId, turn)) await dismissHarnessTurn(turn, this.#log);
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
      const owner = ownerChildRow(state.children, this.#engine.getModel(), threadId, activity);
      if (owner !== undefined) return owner.turnId;
    }
    return this.#engine.getModel().threads[threadId]?.latestTurnId;
  }

  /** C4: caps not cached yet when the session opened: one (cached) status read decides. */
  async #harnessTurnsDeclared(threadId: string): Promise<boolean> {
    const thread = this.#engine.getModel().threads[threadId];
    return thread !== undefined && (await this.#sessions.caps(instanceIdOf(thread))).harnessTurns === true;
  }

  /** A harness turn that will never run: consume its events so the driver frees them. */
  async #releaseHarnessTurn(turn: HarnessTurn | undefined, why: string, turnId: string): Promise<void> {
    if (turn === undefined) return;
    this.#log(`[reactor] discarding harness turn: ${why}`, turnId);
    await dismissHarnessTurn(turn, this.#log);
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
        this.#retargetFallback(event.threadId, event.messageId, event.turn.id, event.turn.status === "queued");
        this.#accept(event.threadId, event.turn.id, textOf(event.userMessage), event.images);
        return;
      case "turn.steered":
        this.#track(this.#steer(event.threadId, event.turnId, event.message.id, { text: textOf(event.message), ...(event.images && event.images.length > 0 ? { images: event.images } : {}) }));
        return;
      case "turn.dequeued":
        this.#known.delete(event.turnId);
        this.#held.delete(event.turnId);
        this.#retargets.forget(event.threadId, event.turnId);
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
        if (isSecretResponse(this.#engine.getModel(), event)) return;
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
        this.#held.delete(event.turnId);
        const state = this.#threads.get(event.threadId);
        if (state) {
          dropTurnKeys(state.activityIds, event.turnId);
          dropTurnKeys(state.messageIds, event.turnId);
        }
        this.#secrets.flush(event.turnId);
        this.#runPromoted(event.threadId, event.turnId);
        return;
      }
      case "turn.released":
        this.#release(event.threadId, event.turnId);
        return;
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
   * `steer.fallback`, and the decider turns the message into a queued turn. A harness turn is
   * named by its key: when the harness already moved on to its next turn (which waits behind
   * this one in Tide), that queued fallback is promoted into it once it runs (`#retargetFallback`).
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
    const turnKey = this.#liveKey.get(threadId);
    try {
      if (turnKey === undefined) await session.steer!(input);
      else await session.steer!(input, { turnKey });
      this.#sessions.touch(threadId);
    } catch (err) {
      this.#log("[reactor] steer refused", err);
      if (turnKey !== undefined && this.#harnessTurns.hasPending(threadId)) this.#retargets.refused(messageId, threadId, turnId);
      await fallback(`the harness refused the message: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * A steer refused because the harness had moved on fell back to a queued turn: promote it into
   * the next harness turn as soon as that runs in Tide (right away if it already does). If it
   * cannot be promoted (images, a handoff) it stays queued and runs as a turn of its own.
   */
  #retargetFallback(threadId: string, messageId: string, turnId: string, queued: boolean): void {
    const origin = this.#retargets.fellBack(messageId, turnId, queued);
    if (origin === undefined) return;
    const live = this.#live.get(threadId);
    if (live !== undefined && live !== origin.fromTurnId && this.#liveKey.has(threadId)) this.#promoteRetargets(threadId);
  }

  #promoteRetargets(threadId: string): void {
    for (const turnId of this.#retargets.take(threadId)) this.#track(this.#dispatchClient({ type: "turn.promote", turnId }));
  }

  /**
   * The projector promotes the oldest queued turn when the live one settles. Normally that turn
   * is already waiting on this thread's chain; after a restart (recovery settled the dead turn)
   * nobody queued it, so it is picked up here from the read model.
   */
  #runPromoted(threadId: string, settledTurnId: string): void {
    const next = this.#engine.getModel().threads[threadId]?.latestTurnId;
    if (next === undefined || next === settledTurnId) return;
    this.#release(threadId, next);
  }

  /** Runs a `requested` turn this reactor never saw requested (promoted after a restart, or left unsent by a graceful shutdown). */
  resume(threadId: string, next: string, known?: TurnInput): void {
    const model = this.#engine.getModel();
    if (this.#known.has(next)) return;
    if (model.threads[threadId]?.latestTurnId !== next || model.turns[next]?.status !== "requested") return;
    const input = known ?? storedInput(model, threadId, next, this.#imagesFor);
    this.#known.add(next);
    this.#enqueue(threadId, () => this.#runTurn(threadId, next, input));
  }

  /**
   * R20: a promoted or released queued turn. If its chain task has not run yet it still waits there
   * (`#known`); otherwise it starts with the input that task kept (`#held`), or from the model.
   */
  #release(threadId: string, turnId: string): void {
    const input = this.#held.get(turnId);
    this.#held.delete(turnId);
    this.resume(threadId, turnId, input);
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
      state = newThreadState();
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

  /** A user-level command the reactor issues on the user's behalf (re-aiming a steer). */
  async #dispatchClient(command: Extract<Command, { type: "turn.promote" | "thread.resume" }>): Promise<void> {
    try {
      await this.#engine.dispatch(command);
    } catch (err) {
      this.#log(`[reactor] ${command.type} rejected`, err);
    }
  }

  /** Every command from a driver passes here: no remembered secret value gets past it. */
  async #dispatch(command: InternalCommand): Promise<void> {
    try {
      await this.#engine.dispatch(this.#secrets.scrub(command));
    } catch (err) {
      this.#log(`[reactor] ${command.type} rejected`, err);
    }
  }

  async #runTurn(threadId: string, turnId: string, input: TurnInput): Promise<void> {
    // a turn the harness is already running: its events replace `send`, no prompt is built
    const attached = this.#harnessTurns.take(turnId);
    this.#retargets.forget(threadId, turnId);
    // dequeued while waiting, or settled by recovery/shutdown: nothing to run
    const status = this.#engine.getModel().turns[turnId]?.status;
    if (status !== "requested") {
      // R20: still queued = held by the settle before it; `turn.released` starts it again
      if (status === "queued" && attached === undefined) {
        this.#known.delete(turnId);
        this.#held.set(turnId, input);
      }
      return this.#releaseHarnessTurn(attached, "turn no longer requested", turnId);
    }
    // Gives the vcs reactor its window to snapshot the working tree before the first tool
    // call, and to attach a worktree, so the session below opens in the final cwd.
    if (this.#beforeTurn) {
      try {
        await this.#beforeTurn(threadId, turnId);
      } catch (err) {
        this.#log("[reactor] beforeTurn hook failed", err);
      }
      // the vcs reactor refuses a turn whose thread was promised a worktree it never got
      if (this.#engine.getModel().turns[turnId]?.status !== "requested") return this.#releaseHarnessTurn(attached, "turn settled before it started", turnId);
    }
    const model = this.#engine.getModel();
    const thread = model.threads[threadId];
    const project = thread ? model.projects[thread.projectId] : undefined;
    if (!thread || !project) {
      await this.#dispatch({ type: "turn.settle", turnId, status: "error", error: "thread or project is gone" });
      return this.#releaseHarnessTurn(attached, "thread or project is gone", turnId);
    }

    let started = false;
    /** D1: set once the session is open: the resume it was asked for did not hold */
    let lost: ResumeLoss | undefined;
    const start = async (nativeSessionId?: string, modelId?: string): Promise<void> => {
      if (started) {
        // R17: the harness named its session after an earlier event already started the turn
        if (nativeSessionId !== undefined) await this.#dispatch({ type: "turn.session", turnId, nativeSessionId, ...(modelId !== undefined ? { model: modelId } : {}) });
        return;
      }
      started = true;
      const command = {
        type: "turn.start" as const,
        turnId,
        provider: thread.provider,
        ...(thread.providerId !== undefined ? { providerId: thread.providerId } : {}),
        ...((modelId ?? thread.model) !== undefined ? { model: modelId ?? thread.model } : {}),
        ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
      };
      // D1: a resume that became a new native session gets its boundary + reason row
      await this.#dispatch(startCommand(command, lost));
      if (lost !== undefined) await this.#dispatch({ type: "activity.upsert", activity: resumeLostActivity(lost, { id: this.#newId(), threadId, turnId, at: this.#now() }) });
    };

    let settled = false;
    const run: TurnRun = {};
    try {
      // an attached turn never opens/reconfigures: that could close the very session running it
      const opened = attached === undefined ? await openTurn(this.#open, thread, project, turnId, input) : undefined;
      if (opened !== undefined) lost = this.#sessions.takeResumeLoss(threadId);
      this.#sessions.touch(threadId);
      const nativeSessionId = (opened?.session ?? this.#sessions.peek(threadId))?.nativeSessionId;
      if (nativeSessionId !== undefined) await start(nativeSessionId);
      this.#live.set(threadId, turnId);
      if (attached?.key !== undefined) this.#liveKey.set(threadId, attached.key);
      // steers the harness refused for the turn before this one belong here
      if (attached !== undefined) this.#promoteRetargets(threadId);
      const events = opened !== undefined ? opened.session.send(opened.prompt) : attached!.events;
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
        await this.#flushHeld(threadId, turnId);
        await this.#dispatch({ type: "turn.settle", turnId, status: "completed" });
        settled = true;
        run.status = "completed";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log("[reactor] driver error", err);
      if (!settled) {
        await start();
        await this.#flushHeld(threadId, turnId);
        // R19 L5: a resume the harness refused gets its own row (the web offers a fresh session)
        const refused = resumeRefusedRow(message, this.#sessions.labelOf(thread), () => ({ id: this.#newId(), threadId, turnId, at: this.#now() }));
        await this.#dispatch({ type: "activity.upsert", activity: refused?.activity ?? this.#errorActivity(threadId, turnId, message) });
        if (isUsageLimitError(message)) run.limited ??= { note: message };
        await this.#dispatch({ type: "turn.settle", turnId, status: "error", error: refused?.error ?? message, ...this.#holdQueue(threadId, run) });
        settled = true;
        run.status = "error";
      }
    } finally {
      if (this.#live.get(threadId) === turnId) {
        this.#live.delete(threadId);
        this.#liveKey.delete(threadId);
      }
    }
    if (settled) await this.#settleLimit(threadId, run);
  }

  /**
   * R20: a turn the limit cut short keeps the thread's queue, so the next turn does not run into
   * the same wall. A harness turn waiting behind it is already running on the harness: not held.
   */
  #holdQueue(threadId: string, run: TurnRun): { holdQueue?: true } {
    return run.limited !== undefined && !this.#harnessTurns.hasPending(threadId) ? { holdQueue: true } : {};
  }

  /**
   * A thread is limited only when the harness refused work: the turn failed or was cut
   * short and a limit signal came with it. A window reported exhausted while the turn
   * completed (an overage window, a warning the plan absorbed) never blocks the thread,
   * and a completed turn clears a limit left from before.
   */
  async #settleLimit(threadId: string, run: TurnRun): Promise<void> {
    if (run.status === "completed") {
      const thread = this.#engine.getModel().threads[threadId];
      if (thread?.limited !== undefined && thread.status !== "running") await this.#dispatchClient({ type: "thread.resume", threadId });
      return;
    }
    if (run.limited !== undefined) {
      await this.#dispatch({
        type: "thread.limited",
        threadId,
        ...(run.limited.resetsAt !== undefined ? { resetsAt: run.limited.resetsAt } : {}),
        ...(run.limited.note !== undefined ? { note: run.limited.note } : {}),
        ...(run.limited.window !== undefined ? { window: run.limited.window } : {}),
      });
    }
  }

  /** Streamed text held back by the secret scrubber (a possible value start) lands before the turn settles. */
  async #flushHeld(threadId: string, turnId: string): Promise<void> {
    const messageIds = this.#threads.get(threadId)?.messageIds;
    for (const { kind, key, text } of this.#secrets.flush(turnId)) {
      const messageId = messageIds?.get(key);
      if (messageId === undefined) continue;
      await this.#dispatch(kind === "text" ? { type: "assistant.append", turnId, messageId, delta: text } : { type: "assistant.reasoning.append", turnId, messageId, delta: text });
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
        const delta = this.#secrets.stream("text", key, event.delta);
        if (delta !== "") await this.#dispatch({ type: "assistant.append", turnId, messageId, delta });
        return false;
      }
      case "assistant.reasoning": {
        const key = `${turnId}:${event.messageKey}`;
        let messageId = state.messageIds.get(key);
        if (messageId === undefined) {
          messageId = this.#newId();
          state.messageIds.set(key, messageId);
        }
        const delta = this.#secrets.stream("reasoning", key, event.delta);
        if (delta !== "") await this.#dispatch({ type: "assistant.reasoning.append", turnId, messageId, delta });
        return false;
      }
      case "activity": {
        // scoped to the turn: Codex request ids restart at 0 per process, tool ids may repeat
        const native = activityKey(event.activity);
        const key = native === undefined ? undefined : `${turnId}:${native}`;
        // a restart empties state.children: the lookup falls back to the thread's timeline
        const owner = ownerChildRow(state.children, this.#engine.getModel(), threadId, event.activity);
        const child = event.activity.kind === "child" ? owner : undefined;
        const parent = event.activity.kind === "child" ? undefined : owner;
        let id = event.activity.id ?? child?.id ?? (key !== undefined ? state.activityIds.get(key) : undefined);
        id ??= this.#newId();
        if (key !== undefined) state.activityIds.set(key, id);
        // a child settling later lands on its own row and turn; its tool rows follow it
        const ownerTurnId = child?.turnId ?? parent?.turnId ?? turnId;
        if (event.activity.kind === "child") rememberChild(state.children, event.activity.childKey, event.activity.taskId, child ?? { id, turnId });
        const at = this.#now();
        const previous = this.#engine.getModel().activities[id];
        const activity = redactSecretTool(mergeActivity(previous, event.activity, { id, threadId, turnId: ownerTurnId, createdAt: at, updatedAt: at }));
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
            ...(event.rateLimit.window !== undefined ? { window: event.rateLimit.window } : {}),
          };
        }
        if (isRedundantGauge(event, knownGauge(this.#engine.getModel(), turnId, event.rateLimit))) return false;
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
        run.status = event.status;
        if (event.status === "error" && isUsageLimitError(event.error)) run.limited ??= { note: event.error as string };
        await this.#flushHeld(threadId, turnId);
        const thread = this.#engine.getModel().threads[threadId];
        const refused = event.status === "error" && thread !== undefined ? resumeRefusedRow(event.error, this.#sessions.labelOf(thread), () => ({ id: this.#newId(), threadId, turnId, at: this.#now() })) : undefined;
        if (refused !== undefined) await this.#dispatch({ type: "activity.upsert", activity: refused.activity });
        const error = refused?.error ?? event.error;
        await this.#dispatch({ type: "turn.settle", turnId, status: event.status, ...(error !== undefined ? { error } : {}), ...(event.status !== "completed" ? this.#holdQueue(threadId, run) : {}) });
        return true;
      default:
        return false;
    }
  }
}
