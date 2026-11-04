import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { recallScroll, rememberScroll, type ScrollPosition } from "../../lib/scrollMemory.ts";

/** Scroll end within this many px re-arms following. */
export const REARM_PX = 40;
/** The "New text" pill waits this long before showing; it hides at once. */
export const PILL_DELAY_MS = 150;
/** No pill this long after a thread switch (the restored view is not news). */
export const SWITCH_GRACE_MS = 300;

/** Same-thread jump: `detail` is `{ threadId, rowKey }` (see `openThreadAt`). */
export const SCROLL_TO_EVENT = "tide:scroll-to";

type Follow = "following" | "released";
type Cancel = () => void;

const RELEASE_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);

function frame(cb: () => void): Cancel {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/**
 * The stream's scroll behaviour for one visit to one thread (the owner remounts per
 * thread, so nothing here outlives the visit). Plain closure state, not React state:
 * deltas and resizes only write `scrollTop`, they never cause a render. The one piece of
 * React state is the pill.
 */
function createController(threadId: string, setShowNew: (value: boolean) => void) {
  let el: HTMLElement | null = null;
  let mode: Follow = "following";
  /** set while a scroll we wrote is in flight, so its scroll event is not read as the user's */
  let holdProgrammatic = false;
  let releaseHold: Cancel | undefined;
  let lastTop = 0;
  /** the first visible row and its offset from the viewport top, for manual anchoring */
  let anchor: { row: Element; offset: number } | undefined;
  let touched = false;
  let shown = false;
  let pillTimer: ReturnType<typeof setTimeout> | undefined;
  let inGrace = true;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelSave: Cancel | undefined;
  let cancelSettle: Cancel | undefined;
  let observer: ResizeObserver | undefined;
  const observed = new Set<Element>();

  const viewTop = (): number => el?.getBoundingClientRect().top ?? 0;

  const setTop = (top: number): void => {
    if (!el || el.scrollTop === top) return;
    holdProgrammatic = true;
    el.scrollTop = top;
    lastTop = el.scrollTop;
    releaseHold?.();
    // scroll events dispatch before animation-frame callbacks, so the hold covers ours
    releaseHold = frame(() => (holdProgrammatic = false));
  };

  const distanceToEnd = (): number => (el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0);
  const overflows = (): boolean => !!el && el.scrollHeight > el.clientHeight + 1;

  /** Index of the first row whose bottom is below the viewport top (rows are stacked in order). */
  const firstVisible = (): number => {
    if (!el) return -1;
    const rows = el.children;
    const top = viewTop();
    let lo = 0;
    let hi = rows.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid]!.getBoundingClientRect().bottom > top + 0.5) {
        found = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return found;
  };

  const recordAnchor = (): void => {
    const i = firstVisible();
    const row = i < 0 ? undefined : el?.children[i];
    anchor = row ? { row, offset: row.getBoundingClientRect().top - viewTop() } : undefined;
  };

  const pin = (): void => {
    if (el) setTop(el.scrollHeight);
  };

  /** Content above the first visible row changed size: move by the same amount so it stays put. */
  const compensate = (): void => {
    if (!el) return;
    if (anchor && anchor.row.isConnected && anchor.row.parentElement === el) {
      const drift = anchor.row.getBoundingClientRect().top - viewTop() - anchor.offset;
      if (Math.abs(drift) >= 0.5) setTop(el.scrollTop + drift);
    }
    recordAnchor();
  };

  const hidePill = (): void => {
    if (pillTimer !== undefined) clearTimeout(pillTimer);
    pillTimer = undefined;
    if (!shown) return;
    shown = false;
    setShowNew(false);
  };

  const scheduleNew = (): void => {
    if (inGrace || shown || pillTimer !== undefined) return;
    pillTimer = setTimeout(() => {
      pillTimer = undefined;
      if (mode !== "released") return;
      shown = true;
      setShowNew(true);
    }, PILL_DELAY_MS);
  };

  const release = (): void => {
    touched = true;
    if (mode === "released") return;
    mode = "released";
    recordAnchor();
  };

  const rearm = (): void => {
    mode = "following";
    hidePill();
  };

  const save = (): void => {
    if (!el || !el.isConnected) return;
    let position: ScrollPosition = { entryId: "", offsetWithinEntry: 0, atEnd: true };
    if (mode === "released") {
      const i = firstVisible();
      const row = i < 0 ? undefined : el.children[i];
      if (!row) return;
      position = { entryId: String(i), offsetWithinEntry: viewTop() - row.getBoundingClientRect().top, atEnd: false };
    }
    rememberScroll(threadId, position);
  };

  const scheduleSave = (): void => {
    cancelSave ??= frame(() => {
      cancelSave = undefined;
      save();
    });
  };

  const findRow = (key: string): Element | undefined =>
    el?.querySelector(`[data-row-key="${key.replace(/["\\]/g, "\\$&")}"]`) ?? undefined;

  const applyMemory = (memory: ScrollPosition): void => {
    const row = memory.rowKey !== undefined ? findRow(memory.rowKey) : memory.entryId === "" ? undefined : el?.children[Number(memory.entryId)];
    if (!el || !row) {
      mode = "following";
      pin();
      return;
    }
    setTop(row.getBoundingClientRect().top - viewTop() + el.scrollTop + memory.offsetWithinEntry);
    recordAnchor();
  };

  const onContentChange = (rowsChanged: boolean): void => {
    if (mode === "following") pin();
    else {
      compensate();
      if (rowsChanged) scheduleNew();
    }
  };

  const onScrollTo = (e: Event): void => {
    const d = (e as CustomEvent<{ threadId: string; rowKey: string }>).detail;
    if (!el || d.threadId !== threadId || !findRow(d.rowKey)) return;
    touched = true;
    mode = "released";
    applyMemory({ entryId: "", rowKey: d.rowKey, offsetWithinEntry: 0, atEnd: false });
    scheduleSave();
  };

  const listeners = {
    wheel: (e: WheelEvent) => {
      if (e.deltaY < 0 && overflows()) release();
    },
    touchmove: () => {
      if (overflows()) release();
    },
    pointerdown: (e: PointerEvent) => {
      if (!el || el.offsetWidth <= el.clientWidth) return;
      if (e.clientX - el.getBoundingClientRect().left >= el.clientWidth) release();
    },
    keydown: (e: KeyboardEvent) => {
      if (RELEASE_KEYS.has(e.key) && !isEditable(e.target) && overflows()) release();
    },
    scroll: () => {
      if (!el) return;
      const top = el.scrollTop;
      if (!holdProgrammatic) {
        const end = distanceToEnd();
        if (mode === "released" && end <= REARM_PX && top >= lastTop) rearm();
        // a scroll up we did not cause and no input reported (overlay scrollbar drag, find in page)
        else if (mode === "following" && top < lastTop - 1 && end > REARM_PX) release();
        else if (top !== lastTop) touched = true;
      }
      lastTop = top;
      recordAnchor();
      scheduleSave();
    },
  };

  return {
    attach(node: HTMLElement): Cancel {
      el = node;
      window.addEventListener(SCROLL_TO_EVENT, onScrollTo);
      for (const [type, fn] of Object.entries(listeners)) node.addEventListener(type, fn as EventListener, { passive: true });
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => onContentChange(false));
        observer.observe(node);
        observed.add(node);
      }
      return () => {
        window.removeEventListener(SCROLL_TO_EVENT, onScrollTo);
        for (const [type, fn] of Object.entries(listeners)) node.removeEventListener(type, fn as EventListener);
        observer?.disconnect();
        observed.clear();
        observer = undefined;
      };
    },
    /** Before the first paint of this visit: back to where the reader left, or the end. */
    restore(): void {
      inGrace = true;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => (inGrace = false), SWITCH_GRACE_MS);
      const memory = recallScroll(threadId);
      if (!memory || memory.atEnd) {
        mode = "following";
        pin();
        return;
      }
      mode = "released";
      applyMemory(memory);
      // async blocks (mermaid, images) may move rows in the first frame: settle once
      cancelSettle = frame(() => {
        cancelSettle = undefined;
        if (!touched && mode === "released") applyMemory(memory);
      });
    },
    /** After a commit that changed this thread's rows (layout phase, before paint). */
    sync(): void {
      if (!el) return;
      if (observer) {
        for (const node of observed) {
          if (node !== el && node.parentElement !== el) {
            observer.unobserve(node);
            observed.delete(node);
          }
        }
        for (const row of el.children) {
          if (observed.has(row)) continue;
          observer.observe(row);
          observed.add(row);
        }
      }
      onContentChange(true);
    },
    jumpToEnd(): void {
      rearm();
      pin();
      save();
    },
    dispose(): void {
      save();
      clearTimeout(graceTimer);
      hidePill();
      releaseHold?.();
      cancelSave?.();
      cancelSettle?.();
    },
  };
}

export interface StreamScrollOptions {
  threadId: string;
  /** changes whenever this thread's rows change (a new row, a delta, a turn settling) */
  rowsSignature: unknown;
  /** the list is mounted (the empty state renders no list) */
  hasRows: boolean;
}

/**
 * Follow-to-bottom for the thread stream as an input-driven state machine:
 * `following` pins the end on every content change (rows, deltas, any resize);
 * wheel-up, touch, a scrollbar press or PageUp/Home/ArrowUp release it, and scrolling
 * back within {@link REARM_PX} of the end re-arms it. While released, size changes above
 * the viewport are compensated so the visible rows stay put. Mount it once per thread
 * visit (key the owner by thread): it restores that thread's saved position before paint.
 */
export function useStreamScroll(
  listRef: RefObject<HTMLElement | null>,
  { threadId, rowsSignature, hasRows }: StreamScrollOptions,
): { showNew: boolean; jumpToEnd: () => void } {
  const [showNew, setShowNew] = useState(false);
  const controller = useRef<ReturnType<typeof createController>>(null);
  controller.current ??= createController(threadId, setShowNew);
  const ctl = controller.current;

  useLayoutEffect(() => {
    const node = listRef.current;
    if (!hasRows || !node) return;
    const detach = ctl.attach(node);
    ctl.restore();
    return () => {
      ctl.dispose();
      detach();
    };
  }, [ctl, listRef, hasRows]);

  useLayoutEffect(() => {
    if (hasRows) ctl.sync();
  }, [ctl, hasRows, rowsSignature]);

  return { showNew, jumpToEnd: ctl.jumpToEnd };
}
