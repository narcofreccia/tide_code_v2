import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { recallScroll, rememberScroll, type ScrollPosition } from "../../lib/scrollMemory.ts";
import { createTouchTracker, frame, isEditable, isReleaseWheel, innerCanScrollUp, scrollDebugOn, type Cancel } from "./streamInput.ts";

/** Scroll end within this many px re-arms following. */
export const REARM_PX = 40;
/** The "New text" pill waits this long before showing; it hides at once. */
export const PILL_DELAY_MS = 150;
/** No pill this long after a thread switch (the restored view is not news). */
export const SWITCH_GRACE_MS = 300;
/**
 * A release is checked this long after the gesture's last input: if the stream did not
 * move up by more than {@link UNMOVED_PX}, it was not reading up, and following resumes.
 */
export const CONFIRM_MS = 120;
/** Upward movement at or under this (a trackpad's reverse flick at the end) counts as none. */
export const UNMOVED_PX = 4;
/** Distance to the end at which a scroll event follows again whatever its direction. */
export const AT_END_PX = 1;

/** Same-thread jump: `detail` is `{ threadId, rowKey }` (see `openThreadAt`). */
export const SCROLL_TO_EVENT = "tide:scroll-to";
/** A message was sent, queued or steered from the composer: `detail` is `{ threadId }`. */
export const MESSAGE_SENT_EVENT = "tide:message-sent";

type Follow = "following" | "released";

const RELEASE_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);

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
  let mutations: MutationObserver | undefined;
  const observed = new Set<Element>();
  /** the stream's end position when an input released it; set until the release is confirmed */
  let releaseTop: number | undefined;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  /** a press on the scrollbar is in progress (confirmed on pointerup) */
  let pressing = false;
  let touch: ReturnType<typeof createTouchTracker> | undefined;
  const debug = scrollDebugOn();

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
      if (Math.abs(drift) >= 0.5) {
        const before = el.scrollTop;
        setTop(before + drift);
        // our own move is not the reader's: the unconfirmed release is measured from here
        if (releaseTop !== undefined) releaseTop += el.scrollTop - before;
      }
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

  const log = (cause: string): void => {
    if (!debug || !el) return;
    console.debug(`[scroll] ${mode}: ${cause}`, { scrollTop: el.scrollTop, toEnd: distanceToEnd() });
  };

  const stopConfirm = (): void => {
    if (confirmTimer !== undefined) clearTimeout(confirmTimer);
    confirmTimer = undefined;
  };

  const rearm = (cause: string): void => {
    stopConfirm();
    releaseTop = undefined;
    if (mode === "following") return;
    mode = "following";
    hidePill();
    log(cause);
  };

  /** (Re)start the check of an unconfirmed release: the gesture's last input pushes it back. */
  const scheduleConfirm = (): void => {
    if (releaseTop === undefined) return;
    stopConfirm();
    confirmTimer = setTimeout(() => {
      confirmTimer = undefined;
      if (releaseTop === undefined || mode !== "released" || !el) return;
      if (el.scrollTop >= releaseTop - UNMOVED_PX) {
        rearm("unmoved-release");
        pin();
      } else releaseTop = undefined;
    }, CONFIRM_MS);
  };

  /**
   * `pending`: an input that may not move the stream (wheel, touch, key, scrollbar press);
   * it stays unconfirmed until the stream moves up, and is undone if it does not.
   */
  const release = (cause: string, pending: boolean): void => {
    touched = true;
    if (mode === "released") return;
    mode = "released";
    recordAnchor();
    // measured from the end, where following kept the view: with passive listeners the browser
    // may already have applied this gesture's scroll when its wheel or touch event reaches us
    releaseTop = pending && el ? el.scrollHeight - el.clientHeight : undefined;
    log(cause);
  };

  const save = (): void => {
    if (!el || !el.isConnected) return;
    let position: ScrollPosition = { entryId: "", offsetWithinEntry: 0, atEnd: true };
    // released but still at the end is an accident, not a place to come back to
    if (mode === "released" && distanceToEnd() > REARM_PX) {
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
    stopConfirm();
    releaseTop = undefined;
    if (mode !== "released") {
      mode = "released";
      log("scroll-to");
    }
    applyMemory({ entryId: "", rowKey: d.rowKey, offsetWithinEntry: 0, atEnd: false });
    scheduleSave();
  };

  const jump = (cause: string): void => {
    rearm(cause);
    pin();
    save();
  };

  const onSent = (e: Event): void => {
    if ((e as CustomEvent<{ threadId: string }>).detail?.threadId === threadId && el) jump("sent");
  };

  /** Rows in the list and nothing else are observed for size (rows also mount on their own). */
  const observeRows = (): void => {
    if (!el || !observer) return;
    for (const node of observed) {
      if (node !== el && node.parentElement !== el) {
        observer.unobserve(node);
        observed.delete(node);
      }
    }
    for (const row of el.children) {
      if (observed.has(row)) continue;
      observer.observe(row, { box: "border-box" });
      observed.add(row);
    }
  };

  /** Each input of a gesture: release when it reads up, and push back the check either way. */
  const input = (reads: boolean, cause: string): void => {
    if (reads && overflows()) release(cause, true);
    scheduleConfirm();
  };

  const listeners = {
    wheel: (e: WheelEvent) => {
      if (el) input(isReleaseWheel(e, el), "wheel");
    },
    touchstart: (e: TouchEvent) => {
      touch?.start(e);
    },
    touchmove: (e: TouchEvent) => {
      input(touch?.move(e) ?? false, "touch");
    },
    touchend: () => {
      touch?.end();
      scheduleConfirm();
    },
    pointerdown: (e: PointerEvent) => {
      if (!el || el.offsetWidth <= el.clientWidth) return;
      if (e.clientX - el.getBoundingClientRect().left < el.clientWidth) return;
      pressing = true;
      if (overflows()) release("scrollbar", true);
    },
    keydown: (e: KeyboardEvent) => {
      if (el && RELEASE_KEYS.has(e.key) && !isEditable(e.target)) input(!innerCanScrollUp(e.target, el), "key");
    },
    scroll: () => {
      if (!el) return;
      const top = el.scrollTop;
      if (!holdProgrammatic) {
        const end = distanceToEnd();
        if (mode === "released" && end <= AT_END_PX) rearm("at-end");
        else if (mode === "released" && end <= REARM_PX && top >= lastTop) rearm("scroll-down");
        // a scroll up we did not cause and no input reported (overlay scrollbar drag, find in page)
        else if (mode === "following" && top < lastTop - 1 && end > REARM_PX) release("scroll-up", false);
        else if (top !== lastTop) touched = true;
        // the reader really went up: the release stands
        if (releaseTop !== undefined && top < releaseTop - UNMOVED_PX) {
          releaseTop = undefined;
          stopConfirm();
        }
      }
      lastTop = top;
      recordAnchor();
      scheduleSave();
    },
  };

  const onPointerUp = (): void => {
    if (!pressing) return;
    pressing = false;
    scheduleConfirm();
  };

  return {
    attach(node: HTMLElement): Cancel {
      el = node;
      touch = createTouchTracker(node);
      window.addEventListener(SCROLL_TO_EVENT, onScrollTo);
      window.addEventListener(MESSAGE_SENT_EVENT, onSent);
      window.addEventListener("pointerup", onPointerUp);
      for (const [type, fn] of Object.entries(listeners)) node.addEventListener(type, fn as EventListener, { passive: true });
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => onContentChange(false));
        observer.observe(node, { box: "border-box" });
        observed.add(node);
      }
      // a row can mount on its own render (a handoff card beside its message), not a rows change
      if (typeof MutationObserver !== "undefined") {
        mutations = new MutationObserver(() => {
          observeRows();
          onContentChange(false);
        });
        mutations.observe(node, { childList: true });
      }
      return () => {
        window.removeEventListener(SCROLL_TO_EVENT, onScrollTo);
        window.removeEventListener(MESSAGE_SENT_EVENT, onSent);
        window.removeEventListener("pointerup", onPointerUp);
        for (const [type, fn] of Object.entries(listeners)) node.removeEventListener(type, fn as EventListener);
        observer?.disconnect();
        mutations?.disconnect();
        observed.clear();
        observer = undefined;
        mutations = undefined;
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
      log("restore");
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
      observeRows();
      onContentChange(true);
    },
    /** the "New text" pill */
    jumpToEnd(): void {
      jump("pill");
    },
    dispose(): void {
      save();
      stopConfirm();
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
 * a real upward gesture (wheel-up the stream itself would take, a touch drag down, a
 * scrollbar press, PageUp/Home/ArrowUp) releases it. A release after which the stream did
 * not move up within {@link CONFIRM_MS} is undone; reaching the end, scrolling back within
 * {@link REARM_PX} of it, or sending a message re-arms it. While released, size changes above
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
