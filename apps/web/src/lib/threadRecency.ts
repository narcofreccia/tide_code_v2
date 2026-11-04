export const THREAD_RECENCY_KEY = "tide.threads.recency";
export const THREAD_RECENCY_CAP = 200;

/** When each thread was last opened (ms), for the palette's recency ranking. */
export function threadRecency(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(THREAD_RECENCY_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [id, ts] of Object.entries(parsed)) if (typeof ts === "number") out[id] = ts;
    return out;
  } catch {
    return {};
  }
}

export function recordThreadOpen(threadId: string, now: number = Date.now()): void {
  const next = { ...threadRecency(), [threadId]: now };
  const ids = Object.keys(next);
  if (ids.length > THREAD_RECENCY_CAP) {
    ids
      .sort((a, b) => next[a]! - next[b]!)
      .slice(0, ids.length - THREAD_RECENCY_CAP)
      .forEach((id) => delete next[id]);
  }
  try {
    window.localStorage.setItem(THREAD_RECENCY_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota: recency is a convenience */
  }
}
