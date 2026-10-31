import { useCallback, useEffect, useState, type RefObject } from "react";

export type OverflowEdge = "none" | "start" | "end" | "both";

/** Which ends of a horizontal scroller hide content (1px slack for subpixel widths). */
export function overflowEdge(el: HTMLElement): OverflowEdge {
  const start = el.scrollLeft > 1;
  const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  return start && end ? "both" : start ? "start" : end ? "end" : "none";
}

/**
 * A mouse wheel only scrolls vertically; on an overflowing horizontal strip turn the
 * vertical delta into scrollLeft so the wheel walks the tabs. Trackpad sideways swipes
 * (|deltaX| ≥ |deltaY|) are left to the browser.
 */
export function useWheelScrollX(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
}

/**
 * Tracks which ends of the scroller have hidden content, for the fade masks. Re-measures on
 * scroll, on resize of the scroller or its children, and whenever `version` changes
 * (tabs opened/closed).
 */
export function useOverflowEdge(ref: RefObject<HTMLElement | null>, version: unknown): OverflowEdge {
  const [edge, setEdge] = useState<OverflowEdge>("none");
  const measure = useCallback(() => {
    if (ref.current) setEdge(overflowEdge(ref.current));
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(el);
      for (const child of Array.from(el.children)) observer.observe(child);
    }
    measure();
    return () => {
      el.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [ref, measure, version]);

  return edge;
}
