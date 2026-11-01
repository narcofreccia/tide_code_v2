import type { ActivityOf, EventRecord, ReadModel, Thread } from "@tide/contracts";
import { isQuiescent, lostInRound, quiescedBy } from "./background.ts";
import type { Engine } from "./engine.ts";
import { RESTART_ERROR, SHUTDOWN_ERROR } from "./recovery.ts";

export type CancelTimer = () => void;

/** Delegates that settle within this window reach their parent as one message. */
export const DELEGATE_BATCH_MS = 2_000;
/** How much of a delegate's last reply rides in the wake-up. */
export const DELEGATE_REPLY_CHARS = 1_500;

const realTimer = (fn: () => void, ms: number): CancelTimer => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export function lastAssistantText(model: ReadModel, threadId: string): string | undefined {
  const ids = model.threadMessages[threadId] ?? [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    const message = id === undefined ? undefined : model.messages[id];
    if (message?.role === "assistant" && message.text.length > 0) return message.text;
  }
  return undefined;
}

/**
 * Which parent is blocked in `agent.thread.wait` (tide_delegate completion=wait, tide_thread_wait)
 * on which child. That call already hands the parent the result, so no wake-up is sent for it.
 */
export class DelegateWaits {
  #waits = new Map<string, number>();

  /** Marks `parentId` as waiting on `childId`; call the returned function when the wait ends. */
  begin(parentId: string, childId: string): () => void {
    const key = `${parentId}\u0000${childId}`;
    this.#waits.set(key, (this.#waits.get(key) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.#waits.get(key) ?? 1) - 1;
      if (left <= 0) this.#waits.delete(key);
      else this.#waits.set(key, left);
    };
  }

  isWaiting(parentId: string, childId: string): boolean {
    return this.#waits.has(`${parentId}\u0000${childId}`);
  }
}

export type DelegateOutcome = "completed" | "interrupted" | "error" | "limited";

export interface FinishedDelegate {
  threadId: string;
  title: string;
  provider: string;
  outcome: DelegateOutcome;
  error?: string;
  lastReply?: string;
  /** background sub-agents of this round that ended without a report (their harness process went away) */
  lostAgents?: number;
  /** the delegates-site verdict, only when it was confident enough to show */
  judge?: { label: string; source: string; confidence: number };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function describeOutcome(d: FinishedDelegate): string {
  if (d.outcome === "limited") return "hit its usage limit";
  return d.error !== undefined ? `${d.outcome} (${d.error})` : d.outcome;
}

function lostNote(n: number | undefined): string {
  if (n === undefined || n === 0) return "";
  return ` ${n} background sub-agent${n === 1 ? "" : "s"} ended without a report.`;
}

function finishedBlock(d: FinishedDelegate): string {
  return [
    `Delegate "${d.title}" (${d.provider}) finished: ${describeOutcome(d)}.${lostNote(d.lostAgents)} Last reply:`,
    d.lastReply !== undefined ? clip(d.lastReply, DELEGATE_REPLY_CHARS) : "(no reply)",
    ...(d.judge !== undefined ? [`Judge: ${d.judge.label} (${d.judge.source} ${d.judge.confidence.toFixed(2)})`] : []),
    `Use tide_delegate_status / tide_thread_read ${d.threadId} for details.`,
  ].join("\n");
}

/** The wake-up a parent gets: one block per delegate, oldest first. */
export function delegatesFinishedText(delegates: readonly FinishedDelegate[]): string {
  return delegates.map(finishedBlock).join("\n\n");
}

export function delegatesFinishedSummary(delegates: readonly FinishedDelegate[]): string {
  const only = delegates.length === 1 ? delegates[0] : undefined;
  if (only?.judge !== undefined) return `${only.title} finished — ${only.judge.label}`;
  return only !== undefined ? `${only.title} finished` : `${delegates.length} delegates finished`;
}

export function childQuestionText(child: Pick<Thread, "id" | "title">, activity: ActivityOf<"user-input">): string {
  const questions = activity.questions.map((q) => q.text).join(" / ");
  return `Delegate "${child.title}" asks: ${questions}; answer with tide_pending_respond threadId=${child.id} requestId=${activity.requestId} or ask the user`;
}

export interface DelegationReactorOptions {
  engine: Engine;
  waits?: DelegateWaits;
  /** one-shot timer for the batch window (tests pass a manual clock) */
  schedule?: (fn: () => void, ms: number) => CancelTimer;
  batchMs?: number;
  /** gray zone getter: a delegate's judge verdict below `low` is left out of the wake-up */
  grayZone?: () => { low: number; high: number };
  log?: (msg: string, data?: unknown) => void;
}

interface Batch {
  /** child id → latest outcome; insertion order = settle order */
  delegates: Map<string, { outcome: DelegateOutcome; error?: string; lostAgents?: number }>;
  cancel: CancelTimer;
}

/**
 * Wakes the thread that delegated when a delegate finishes, hits its usage limit or asks a
 * question. "Finishes" means quiescent (`threadQuiet`): a delegate whose turn settled while its
 * background sub-agents work is still working; it finishes when the harness turn their report
 * starts settles (with that final reply), or when the last of them is closed as lost. Each
 * quiet spell starts with exactly one event (`quiescedBy`), so the wake-up is sent once; the
 * events are live only, so a restart replays none of them (see `resumeAfterRestart`).
 * Everything reaches the parent as an ordinary `turn.request` with a notification: queued behind
 * a running turn, started on an idle one. Finishes within `batchMs` of each other become one
 * message. A question's wake-up is dequeued again when it is answered before it ran.
 */
export class DelegationReactor {
  #engine: Engine;
  #waits: DelegateWaits | undefined;
  #schedule: (fn: () => void, ms: number) => CancelTimer;
  #batchMs: number;
  #grayZone: (() => { low: number; high: number }) | undefined;
  #log: (msg: string, data?: unknown) => void;
  #batches = new Map<string, Batch>();
  /** delegates that hit their usage limit while still working: reported as limited once quiet */
  #limitedBusy = new Set<string>();
  /** user-input activity id → the parent turn that relays it */
  #questions = new Map<string, { parentId: string; turnId?: string }>();
  #inflight = new Set<Promise<unknown>>();
  #unsubscribe: (() => void) | undefined;

  constructor(options: DelegationReactorOptions) {
    this.#engine = options.engine;
    this.#waits = options.waits;
    this.#schedule = options.schedule ?? realTimer;
    this.#batchMs = options.batchMs ?? DELEGATE_BATCH_MS;
    this.#grayZone = options.grayZone;
    this.#log = options.log ?? ((msg, data) => (data === undefined ? console.error(msg) : console.error(msg, data)));
  }

  start(): void {
    this.#unsubscribe ??= this.#engine.subscribe((record) => this.#onRecord(record));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const batch of this.#batches.values()) batch.cancel();
    this.#batches.clear();
  }

  /**
   * After a restart: `threadIds` had background sub-agents when the previous process died (read
   * before recovery). Recovery closed them as lost without this reactor listening, so a delegate
   * among them that is now quiet wakes its parent here. It happens once: the next boot finds
   * none of them running. Call after `start()`.
   */
  resumeAfterRestart(threadIds: Iterable<string>): void {
    const model = this.#engine.getModel();
    for (const threadId of threadIds) {
      const child = model.threads[threadId];
      if (child?.delegatedBy !== undefined && isQuiescent(model, threadId)) this.#quiet(model, child);
    }
  }

  /**
   * Sends every open batch now instead of at the end of its window. Shutdown calls it after the
   * sessions closed (their background sub-agents closed as lost): the wake-up lands in the log
   * as a requested parent turn, which recovery runs after the restart.
   */
  flushAll(): void {
    for (const [parentId, batch] of [...this.#batches]) {
      batch.cancel();
      this.#flush(parentId);
    }
  }

  /** Resolves when the engine is drained and no wake-up dispatch is in flight (open batches stay open). */
  async drain(): Promise<void> {
    for (let i = 0; i < 1_000; i++) {
      await this.#engine.drain();
      if (this.#inflight.size === 0) return;
      await Promise.allSettled([...this.#inflight]);
    }
    throw new Error("delegation reactor did not drain");
  }

  #onRecord(record: EventRecord): void {
    const event = record.event;
    if (event.type === "turn.settled") this.#cancelAnsweredQuestions(this.#engine.getModel(), event.threadId);
    if (event.type === "turn.settled" || event.type === "activity.upserted") {
      const model = this.#engine.getModel();
      const quiet = quiescedBy(model, event);
      const child = quiet === undefined ? undefined : model.threads[quiet];
      if (child?.delegatedBy !== undefined) this.#quiet(model, child);
    }
    switch (event.type) {
      case "thread.limited": {
        const model = this.#engine.getModel();
        const child = model.threads[event.threadId];
        if (child?.delegatedBy === undefined) return;
        if (isQuiescent(model, child.id)) this.#finished(child, "limited", undefined, lostInRound(model, child.id));
        else this.#limitedBusy.add(child.id);
        return;
      }
      case "activity.upserted": {
        const a = event.activity;
        if (a.kind !== "user-input" || a.status !== "pending" || this.#questions.has(a.id)) return;
        const model = this.#engine.getModel();
        const child = model.threads[a.threadId];
        const parent = child?.delegatedBy === undefined ? undefined : model.threads[child.delegatedBy];
        if (!child || !parent || parent.archivedAt !== undefined) return;
        const entry: { parentId: string; turnId?: string } = { parentId: parent.id };
        this.#questions.set(a.id, entry);
        this.#track(
          this.#request(parent.id, childQuestionText(child, a), { source: "child-question", summary: `${child.title} asks a question` }).then((turnId) => {
            if (turnId === undefined) {
              this.#questions.delete(a.id);
              return;
            }
            entry.turnId = turnId;
            // answered while the dispatch was in flight
            this.#cancelAnsweredQuestions(this.#engine.getModel(), child.id);
          }),
        );
        return;
      }
      case "user-input.responded":
        this.#cancelAnsweredQuestions(this.#engine.getModel(), event.threadId);
        return;
      default:
        return;
    }
  }

  /** The delegate went quiet: its outcome is its latest turn's, unless it hit its limit meanwhile. */
  #quiet(model: ReadModel, child: Thread): void {
    const lost = lostInRound(model, child.id);
    if (this.#limitedBusy.delete(child.id)) {
      this.#finished(child, "limited", undefined, lost);
      return;
    }
    const turn = child.latestTurnId === undefined ? undefined : model.turns[child.latestTurnId];
    // the turn died with the server (shutdown, or recovery after a crash): that wakes no parent
    if (turn?.error === SHUTDOWN_ERROR || turn?.error === RESTART_ERROR) return;
    const outcome: DelegateOutcome = turn?.status === "interrupted" || turn?.status === "error" ? turn.status : "completed";
    this.#finished(child, outcome, turn?.error, lost);
  }

  #finished(child: Thread, outcome: DelegateOutcome, error: string | undefined, lostAgents: number): void {
    const parentId = child.delegatedBy;
    if (parentId === undefined) return;
    const parent = this.#engine.getModel().threads[parentId];
    if (!parent || parent.archivedAt !== undefined) return;
    // checked now, while the wait is still registered: it returns the result itself
    if (this.#waits?.isWaiting(parentId, child.id) === true) return;
    let batch = this.#batches.get(parentId);
    if (batch === undefined) {
      const cancel = this.#schedule(() => this.#flush(parentId), this.#batchMs);
      batch = { delegates: new Map(), cancel };
      this.#batches.set(parentId, batch);
    }
    const previous = batch.delegates.get(child.id);
    // an error settle followed by `thread.limited` is one event for the parent: the limit
    if (previous?.outcome === "limited") return;
    batch.delegates.set(child.id, { outcome, ...(error !== undefined ? { error } : {}), ...(lostAgents > 0 ? { lostAgents } : {}) });
  }

  #flush(parentId: string): void {
    const batch = this.#batches.get(parentId);
    this.#batches.delete(parentId);
    if (batch === undefined || batch.delegates.size === 0) return;
    const model = this.#engine.getModel();
    const parent = model.threads[parentId];
    if (!parent || parent.archivedAt !== undefined) return;
    const delegates: FinishedDelegate[] = [];
    for (const [threadId, { outcome, error, lostAgents }] of batch.delegates) {
      const child = model.threads[threadId];
      if (!child) continue;
      const lastReply = lastAssistantText(model, threadId);
      const low = this.#grayZone?.().low;
      const j = child.judge;
      const judge = j?.label !== undefined && low !== undefined && j.confidence >= low ? { label: j.label, source: j.source, confidence: j.confidence } : undefined;
      delegates.push({
        threadId,
        title: child.title,
        provider: child.provider,
        outcome,
        ...(error !== undefined ? { error } : {}),
        ...(lastReply !== undefined ? { lastReply } : {}),
        ...(lostAgents !== undefined ? { lostAgents } : {}),
        ...(judge !== undefined ? { judge } : {}),
      });
    }
    if (delegates.length === 0) return;
    this.#track(this.#request(parentId, delegatesFinishedText(delegates), { source: "delegate", summary: delegatesFinishedSummary(delegates) }));
  }

  /** Dequeues the relay of every question of `childId` that is no longer pending, if it has not run yet. */
  #cancelAnsweredQuestions(model: ReadModel, childId: string): void {
    for (const [activityId, entry] of this.#questions) {
      const a = model.activities[activityId];
      if (a !== undefined && a.threadId !== childId) continue;
      if (a?.kind === "user-input" && a.status === "pending") continue;
      if (entry.turnId === undefined) continue; // dispatch still in flight; it re-checks when it lands
      this.#questions.delete(activityId);
      if (model.turns[entry.turnId]?.status !== "queued") continue;
      const turnId = entry.turnId;
      this.#track(
        this.#engine.dispatch({ type: "turn.dequeue", turnId }).catch((err: unknown) => this.#log("[delegation] dequeue failed", err)),
      );
    }
  }

  async #request(parentId: string, text: string, notification: { source: "delegate" | "child-question"; summary: string }): Promise<string | undefined> {
    try {
      const result = await this.#engine.dispatch({ type: "turn.request", threadId: parentId, text, notification });
      const requested = result.events.find((r) => r.event.type === "turn.requested")?.event;
      return requested?.type === "turn.requested" ? requested.turn.id : undefined;
    } catch (err) {
      // archived, rolling back or detached since: the parent's own state wins
      this.#log("[delegation] could not wake the parent thread", err);
      return undefined;
    }
  }

  #track(promise: Promise<unknown>): void {
    const tracked = promise.finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
  }
}
