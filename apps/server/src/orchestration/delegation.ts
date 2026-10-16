import type { ActivityOf, EventRecord, ReadModel, Thread } from "@tide/contracts";
import type { Engine } from "./engine.ts";

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

function finishedBlock(d: FinishedDelegate): string {
  return [
    `Delegate "${d.title}" (${d.provider}) finished: ${describeOutcome(d)}. Last reply:`,
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
  delegates: Map<string, { outcome: DelegateOutcome; error?: string }>;
  cancel: CancelTimer;
}

/**
 * Wakes the thread that delegated when a delegate settles, hits its usage limit or asks a
 * question. Everything reaches the parent as an ordinary `turn.request` with a notification:
 * queued behind a running turn, started on an idle one. Settles within `batchMs` of each other
 * become one message. A question's wake-up is dequeued again when it is answered before it ran.
 */
export class DelegationReactor {
  #engine: Engine;
  #waits: DelegateWaits | undefined;
  #schedule: (fn: () => void, ms: number) => CancelTimer;
  #batchMs: number;
  #grayZone: (() => { low: number; high: number }) | undefined;
  #log: (msg: string, data?: unknown) => void;
  #batches = new Map<string, Batch>();
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
    switch (event.type) {
      case "turn.settled": {
        const model = this.#engine.getModel();
        const child = model.threads[event.threadId];
        this.#cancelAnsweredQuestions(model, event.threadId);
        // a queued turn was promoted: the delegate is still working
        if (child?.delegatedBy === undefined || child.status === "running") return;
        this.#finished(child, event.status, event.error);
        return;
      }
      case "thread.limited": {
        const child = this.#engine.getModel().threads[event.threadId];
        if (child?.delegatedBy !== undefined) this.#finished(child, "limited", undefined);
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

  #finished(child: Thread, outcome: DelegateOutcome, error: string | undefined): void {
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
    batch.delegates.set(child.id, { outcome, ...(error !== undefined ? { error } : {}) });
  }

  #flush(parentId: string): void {
    const batch = this.#batches.get(parentId);
    this.#batches.delete(parentId);
    if (batch === undefined || batch.delegates.size === 0) return;
    const model = this.#engine.getModel();
    const parent = model.threads[parentId];
    if (!parent || parent.archivedAt !== undefined) return;
    const delegates: FinishedDelegate[] = [];
    for (const [threadId, { outcome, error }] of batch.delegates) {
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
