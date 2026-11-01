/**
 * Where the reader left each thread's stream, so switching back lands on the same line.
 * `entryId` names a top-level row of the stream (its position among the list's
 * children), `offsetWithinEntry` how far the viewport's top edge sits into that row, and
 * `atEnd` that the stream was following the end (restore to the bottom instead).
 */
export interface ScrollPosition {
  entryId: string;
  offsetWithinEntry: number;
  atEnd: boolean;
}

export const SCROLL_MEMORY_LIMIT = 100;

/** Insertion order doubles as recency: a write moves the thread to the back. */
const memory = new Map<string, ScrollPosition>();

export function rememberScroll(threadId: string, position: ScrollPosition): void {
  memory.delete(threadId);
  memory.set(threadId, position);
  while (memory.size > SCROLL_MEMORY_LIMIT) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

export function recallScroll(threadId: string): ScrollPosition | undefined {
  return memory.get(threadId);
}

export function forgetAllScroll(): void {
  memory.clear();
}
