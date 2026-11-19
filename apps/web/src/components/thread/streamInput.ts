/**
 * Input reading for the stream's follow controller (`useStreamScroll.ts`): which wheel,
 * touch and key events are a reader going up the stream, as opposed to scrolling something
 * inside a row, swiping sideways, or zooming.
 */

export type Cancel = () => void;

/** A touch drag releases once the finger has moved down this far (the view goes up). */
export const TOUCH_SLOP_PX = 6;

export function frame(cb: () => void): Cancel {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
}

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

const SCROLLS = new Set(["auto", "scroll", "overlay"]);

/**
 * A vertical scroller between `target` and `root` (exclusive) that can still go up: the
 * gesture is its, not the stream's. One already at its top lets the gesture through.
 */
export function innerCanScrollUp(target: EventTarget | null, root: Element): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== root) {
    if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight + 1 && SCROLLS.has(getComputedStyle(node).overflowY)) return true;
    node = node.parentElement;
  }
  return false;
}

/** Wheel up, mostly vertical, not a pinch (ctrl+wheel), and not taken by a scroller inside a row. */
export function isReleaseWheel(e: WheelEvent, root: Element): boolean {
  return e.deltaY < 0 && Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.ctrlKey && !innerCanScrollUp(e.target, root);
}

/** `localStorage["tide.debug.scroll"] === "1"` turns on the follow/release log. */
export function scrollDebugOn(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("tide.debug.scroll") === "1";
  } catch {
    return false;
  }
}

/**
 * Touch: remembers the highest point the finger reached in this drag, and reports a release
 * once it has come down {@link TOUCH_SLOP_PX} from there (dragging the content down shows
 * what is above). A drag that starts on a scroller that can still go up is that scroller's.
 */
export function createTouchTracker(root: Element) {
  let top: number | undefined;
  let inner = false;
  return {
    start(e: TouchEvent): void {
      top = e.touches[0]?.clientY;
      inner = innerCanScrollUp(e.target, root);
    },
    /** true when this move is a reader pulling the stream up */
    move(e: TouchEvent): boolean {
      const y = e.touches[0]?.clientY;
      if (y === undefined) return false;
      if (top === undefined || y < top) {
        top = y;
        return false;
      }
      return !inner && y - top > TOUCH_SLOP_PX;
    },
    end(): void {
      top = undefined;
      inner = false;
    },
  };
}
