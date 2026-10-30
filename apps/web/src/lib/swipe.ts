import { useCallback, useRef, useState } from "react";

/** Horizontal travel that commits a swipe. */
export const SWIPE_COMMIT_PX = 80;
/** Movement before the gesture picks an axis. */
export const SWIPE_LOCK_PX = 10;

export type SwipeAxis = "x" | "y";

/** Which axis a drag belongs to: undecided until it has moved, then the dominant one. */
export function lockAxis(dx: number, dy: number): SwipeAxis | undefined {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_LOCK_PX) return undefined;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/** What releasing at `dx` does: right and left commit past the threshold, otherwise nothing. */
export function swipeOutcome(dx: number): "right" | "left" | undefined {
  if (dx >= SWIPE_COMMIT_PX) return "right";
  if (dx <= -SWIPE_COMMIT_PX) return "left";
  return undefined;
}

export interface SwipeRow {
  /** current horizontal offset, clamped, for the row's transform */
  dx: number;
  /** side being revealed while dragging */
  reveal: "right" | "left" | undefined;
  /** true once past the commit threshold */
  armed: boolean;
  dragging: boolean;
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
  };
}

const MAX_TRAVEL = 140;

/**
 * Pointer-event swipe for a list row: right ≥ 80px fires `onRight`, left fires `onLeft`.
 * A drag that is mostly vertical hands the gesture back to scrolling (cancelled, no action).
 */
export function useSwipeRow(onLeft: () => void, onRight: () => void): SwipeRow {
  const start = useRef<{ x: number; y: number; id: number } | undefined>(undefined);
  const axis = useRef<SwipeAxis | undefined>(undefined);
  const [dx, setDx] = useState(0);

  const reset = useCallback(() => {
    start.current = undefined;
    axis.current = undefined;
    setDx(0);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    axis.current = undefined;
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    axis.current ??= lockAxis(mx, my);
    if (axis.current === undefined) return;
    if (axis.current === "y") {
      reset();
      return;
    }
    if (typeof e.currentTarget.setPointerCapture === "function") {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    }
    setDx(Math.max(-MAX_TRAVEL, Math.min(MAX_TRAVEL, mx)));
  }, [reset]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const locked = axis.current === "x";
    const outcome = locked ? swipeOutcome(e.clientX - s.x) : undefined;
    reset();
    if (outcome === "right") onRight();
    else if (outcome === "left") onLeft();
  }, [onLeft, onRight, reset]);

  return {
    dx,
    reveal: dx > 0 ? "right" : dx < 0 ? "left" : undefined,
    armed: Math.abs(dx) >= SWIPE_COMMIT_PX,
    dragging: axis.current === "x",
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: reset },
  };
}
