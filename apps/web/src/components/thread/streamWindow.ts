import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { TimelineItem } from "@tide/client";
import type { Turn } from "@tide/contracts";

/** The turn an item belongs to (every timeline item carries one). */
function turnOf(item: TimelineItem): string {
  switch (item.kind) {
    case "message":
      return item.message.turnId;
    case "activity":
      return item.activity.turnId;
    case "plan":
      return item.plan.turnId;
    case "boundary":
      return item.turnId;
  }
}

/**
 * R24: the items of the turns from `start` on (the loaded window), plus any item whose turn
 * is not in the thread's turn list. `start` 0 hands back the same array.
 */
export function windowItems(items: readonly TimelineItem[], turns: readonly Turn[], start: number): readonly TimelineItem[] {
  if (start <= 0) return items;
  const hidden = new Set<string>();
  for (let i = 0; i < start && i < turns.length; i++) hidden.add(turns[i]!.id);
  return items.filter((item) => !hidden.has(turnOf(item)));
}

/**
 * Keeps one row where it is on screen while earlier turns are inserted above it: `hold` the
 * first row below "Show earlier" before the fetch; when the rows change, the scroll moves by
 * however far that row moved, until `active` turns false (the window grew).
 * Runs after `useStreamScroll`'s own layout effect, so a move it already compensated is not
 * counted twice.
 */
export function useKeepRowInPlace(scroller: RefObject<HTMLElement | null>, rowsSignature: unknown, active: boolean): (row: Element | null) => void {
  const held = useRef<{ row: Element; top: number } | null>(null);
  useLayoutEffect(() => {
    const h = held.current;
    const el = scroller.current;
    if (h === null || el === null) return;
    if (h.row.isConnected) {
      const drift = h.row.getBoundingClientRect().top - h.top;
      if (Math.abs(drift) >= 0.5) el.scrollTop += drift;
      h.top = h.row.getBoundingClientRect().top;
    }
    if (!active) held.current = null;
  }, [scroller, rowsSignature, active]);
  return useCallback((row) => {
    held.current = row === null ? null : { row, top: row.getBoundingClientRect().top };
  }, []);
}
