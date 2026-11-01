import type { EventRecord } from "@tide/contracts";

/**
 * Live-delta coalescer for one `model.subscribe` stream.
 *
 * Runs of `assistant.delta` / `assistant.reasoning-delta` records for the same
 * (type, threadId, messageId) are merged into one record: `delta` is the
 * concatenation, `seq`/`ts` come from the last merged record, every other field
 * from the first. `applyRecord` only requires seq to increase and the projector
 * appends delta text, so the merged record projects exactly like the run did.
 *
 * Policy: a single pending slot. Anything that cannot extend the pending run
 * (another type, another message, a non-delta) flushes it first, so emitted
 * order is always the log order. The slot also flushes when the window timer
 * fires, when the merged delta reaches the size cap, and on close.
 */

export const COALESCE_MS = 60;
/** Cap on a merged delta, in UTF-16 code units (~16 KB of ASCII). */
export const COALESCE_MAX_CHARS = 16 * 1024;

export interface CoalesceTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimer: CoalesceTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CoalesceOptions {
  windowMs?: number;
  maxChars?: number;
  timer?: CoalesceTimer;
}

export interface DeltaCoalescer {
  /** Hand over one live record; it is emitted now or merged into the pending run. */
  push(record: EventRecord): void;
  /** Emit the pending run, if any. */
  flush(): void;
  /** Flush and stop the timer; later pushes pass straight through. */
  close(): void;
}

type DeltaEvent = Extract<EventRecord["event"], { type: "assistant.delta" | "assistant.reasoning-delta" }>;
type DeltaRecord = EventRecord & { event: DeltaEvent };

function isDelta(event: EventRecord["event"]): event is DeltaEvent {
  return event.type === "assistant.delta" || event.type === "assistant.reasoning-delta";
}

export function createDeltaCoalescer(emit: (record: EventRecord) => void, options: CoalesceOptions = {}): DeltaCoalescer {
  const windowMs = options.windowMs ?? COALESCE_MS;
  const maxChars = options.maxChars ?? COALESCE_MAX_CHARS;
  const timer = options.timer ?? realTimer;

  let head: DeltaRecord | null = null;
  let parts: string[] = [];
  let chars = 0;
  let lastSeq = 0;
  let lastTs = 0;
  let handle: unknown = null;
  let closed = false;

  const flush = (): void => {
    if (handle !== null) {
      timer.clear(handle);
      handle = null;
    }
    if (head === null) return;
    const first = head;
    const merged = parts.length > 1;
    const delta = merged ? parts.join("") : first.event.delta;
    head = null;
    parts = [];
    chars = 0;
    emit(merged ? { seq: lastSeq, ts: lastTs, event: { ...first.event, delta } } : first);
  };

  const continues = (event: DeltaEvent): boolean =>
    head !== null &&
    head.event.type === event.type &&
    head.event.threadId === event.threadId &&
    head.event.messageId === event.messageId;

  return {
    push(record) {
      const event = record.event;
      if (closed || !isDelta(event)) {
        flush();
        emit(record);
        return;
      }
      if (!continues(event)) {
        flush();
        head = { ...record, event };
        handle = timer.set(flush, windowMs);
      }
      parts.push(event.delta);
      chars += event.delta.length;
      lastSeq = record.seq;
      lastTs = record.ts;
      if (chars >= maxChars) flush();
    },
    flush,
    close() {
      flush();
      closed = true;
    },
  };
}
