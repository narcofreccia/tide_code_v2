/**
 * Coalesces model publication to the display's frame rate. Streaming sends many records
 * per WebSocket frame; applying each is cheap, re-rendering after each is not, so the
 * stores apply per record and publish at most once per animation frame.
 *
 * `scheduleFrame` is shared: callbacks queued while a frame's batch runs (a store's
 * publish waking the environment manager's merge) run in the same pass, so stacked
 * batchers still cost one frame of latency, not one per layer.
 */

/** Runs `cb` later; tests inject a fake to step frames by hand. */
export type FrameScheduler = (cb: () => void) => void;

interface FrameGlobals {
  requestAnimationFrame?: (cb: () => void) => unknown;
  document?: { visibilityState?: string; addEventListener?: (t: string, cb: () => void) => void; removeEventListener?: (t: string, cb: () => void) => void };
}

const g = globalThis as unknown as FrameGlobals;

const queue = new Set<() => void>();
let pending = false;
/** the pending run waits on rAF, which a page hidden since then never delivers */
let viaFrame = false;

function runQueue(): void {
  // still pending while the loop runs: what a callback queues joins this pass
  pending = true;
  try {
    while (queue.size > 0) {
      const batch = [...queue];
      queue.clear();
      for (const cb of batch) cb();
    }
  } finally {
    pending = false;
    viaFrame = false;
    // a throwing callback leaves the rest for the next frame
    if (queue.size > 0) scheduleFrame(() => undefined);
  }
}

/**
 * The default scheduler: one shared frame callback for every batcher in the page.
 * rAF while visible; a hidden page gets no frames, so a macrotask there (and without
 * rAF at all). A run that is idempotent on an empty queue makes a late rAF harmless.
 */
export const scheduleFrame: FrameScheduler = (cb) => {
  queue.add(cb);
  const hidden = g.document?.visibilityState === "hidden";
  if (pending && !(viaFrame && hidden)) return;
  pending = true;
  viaFrame = !hidden && typeof g.requestAnimationFrame === "function";
  if (viaFrame) g.requestAnimationFrame?.(runQueue);
  else setTimeout(runQueue, 0);
};

/** Calls `cb` when the page becomes hidden (a queued rAF would stall there); no-op outside a browser. */
export function onPageHidden(cb: () => void): () => void {
  const doc = g.document;
  if (!doc?.addEventListener || !doc.removeEventListener) return () => undefined;
  const listener = (): void => {
    if (doc.visibilityState === "hidden") cb();
  };
  doc.addEventListener("visibilitychange", listener);
  return () => doc.removeEventListener?.("visibilitychange", listener);
}
