import { create } from "zustand";
import type { ReadModel, Thread } from "@tide/contracts";

/**
 * Unread dots. Per thread, how many timeline entries (messages, activities, plans)
 * the user has seen; more than that = activity since they last looked. `since`
 * is when this browser started tracking: threads never opened count as unread
 * only for activity after it, so a first launch shows no dots.
 * Timeline length rather than `updatedAt`, so the user's own pin / rename /
 * settle never paints a dot.
 */
interface LastSeenState {
  since: number;
  seen: Record<string, number>;
}

export const LAST_SEEN_KEY = "tide.lastSeen";
const MAX_ENTRIES = 500;

function load(): LastSeenState {
  try {
    const raw = window.localStorage.getItem(LAST_SEEN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LastSeenState>;
      if (typeof parsed.since === "number" && parsed.seen && typeof parsed.seen === "object") {
        return { since: parsed.since, seen: parsed.seen };
      }
    }
  } catch {
    /* storage blocked or corrupt: start fresh */
  }
  return { since: Date.now(), seen: {} };
}

function save(state: LastSeenState): void {
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(state));
  } catch {
    /* private window: dots still work for this session */
  }
}

export const useLastSeen = create<LastSeenState>(() => load());

/** How much has happened in a thread, as far as the dot is concerned. */
export function activityCount(model: ReadModel, threadId: string): number {
  return (model.threadTimeline[threadId] ?? model.threadMessages[threadId] ?? []).length;
}

export function markSeen(threadId: string, count: number): void {
  const state = useLastSeen.getState();
  if (state.seen[threadId] === count) return;
  const entries = Object.entries({ ...state.seen, [threadId]: count });
  // keep the newest entries; insertion order is good enough
  const seen = Object.fromEntries(entries.slice(-MAX_ENTRIES));
  const next = { since: state.since, seen };
  useLastSeen.setState(next);
  save(next);
}

/**
 * The rail's dot: activity since the user last looked, on a thread that is
 * neither open nor running (a running thread's glyph already says it is busy).
 */
export function isUnread(
  thread: Thread,
  count: number,
  state: LastSeenState,
  selectedThreadId: string | null,
): boolean {
  if (thread.id === selectedThreadId || thread.status === "running") return false;
  if (thread.archivedAt !== undefined || thread.settledAt !== undefined) return false;
  const seen = state.seen[thread.id];
  if (seen !== undefined) return count > seen;
  return count > 0 && thread.updatedAt > state.since;
}

/** Test seam. */
export function resetLastSeen(since: number = 0): void {
  useLastSeen.setState({ since, seen: {} });
}
