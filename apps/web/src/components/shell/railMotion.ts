import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Rail rows slide when they change group or place (FLIP): the old positions are
 * read during render, before React commits; after the commit each moved row is
 * drawn back at its old spot and animated to the new one over `--dur` `--ease`.
 * New rows fade and slide in 8px. Rows that left are not animated (they are gone).
 */

export interface RowPos {
  top: number;
  left: number;
}
export interface RowMove {
  id: string;
  dx: number;
  dy: number;
}

/** Most rows animated in one update; the rest just land. */
export const FLIP_CAP = 40;
const ENTER_OFFSET = 8;
const FLIP_ID = "rail-flip";

/**
 * Pure FLIP math. `moved`: rows present before and after whose position changed by
 * more than half a pixel, with the offset from new to old. `entered`: rows that are
 * new (none on the first measure, when there is no `before`). Together capped at `cap`.
 */
export function flipDeltas(
  before: ReadonlyMap<string, RowPos> | undefined,
  after: ReadonlyMap<string, RowPos>,
  cap: number = FLIP_CAP,
): { moved: RowMove[]; entered: string[] } {
  const moved: RowMove[] = [];
  const entered: string[] = [];
  if (before === undefined || before.size === 0) return { moved, entered };
  for (const [id, now] of after) {
    if (moved.length + entered.length >= cap) break;
    const was = before.get(id);
    if (was === undefined) {
      entered.push(id);
      continue;
    }
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moved.push({ id, dx, dy });
  }
  return { moved, entered };
}

function rows(root: HTMLElement): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>();
  for (const el of root.querySelectorAll<HTMLElement>("[data-rail-thread]")) {
    const id = el.dataset.railThread;
    if (id !== undefined && id !== "" && !out.has(id)) out.set(id, el);
  }
  return out;
}

/** Row positions relative to the list, so a scroll between the two reads cancels out. */
export function measureRows(root: HTMLElement): Map<string, RowPos> {
  const origin = root.getBoundingClientRect();
  const out = new Map<string, RowPos>();
  for (const [id, el] of rows(root)) {
    const r = el.getBoundingClientRect();
    out.set(id, { top: r.top - origin.top, left: r.left - origin.left });
  }
  return out;
}

/** `200ms` / `0.2s` → ms; 0 when unset (reduced motion sets `--dur: 0ms`). */
export function parseDuration(value: string): number {
  const v = value.trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return v.endsWith("ms") ? n : v.endsWith("s") ? n * 1000 : n;
}

function prefersStill(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function cancelFlips(el: HTMLElement): void {
  if (typeof el.getAnimations !== "function") return;
  for (const a of el.getAnimations()) if (a.id === FLIP_ID) a.cancel();
}

function play(el: HTMLElement, frames: Keyframe[], duration: number, easing: string): void {
  if (typeof el.animate !== "function") return;
  const animation = el.animate(frames, { duration, easing });
  animation.id = FLIP_ID;
}

/**
 * FLIP the rows under `ref` whenever `signature` (the rail's order: groups, ids,
 * folds) changes. Ordinary re-renders (streaming text, a ticking clock) cost nothing.
 */
export function useRailFlip(ref: RefObject<HTMLElement | null>, signature: string): void {
  const last = useRef<string | undefined>(undefined);
  const before = useRef<Map<string, RowPos> | undefined>(undefined);
  // render phase: the DOM still shows the old order, so this is where "first" is read
  if (last.current !== undefined && last.current !== signature && before.current === undefined && ref.current !== null) {
    before.current = measureRows(ref.current);
  }

  useLayoutEffect(() => {
    const prev = before.current;
    before.current = undefined;
    last.current = signature;
    const root = ref.current;
    if (prev === undefined || root === null || prefersStill()) return;
    const els = rows(root);
    for (const el of els.values()) cancelFlips(el);
    const style = getComputedStyle(root);
    const duration = parseDuration(style.getPropertyValue("--dur"));
    if (duration <= 0) return;
    const easing = style.getPropertyValue("--ease").trim() || "ease-out";
    const { moved, entered } = flipDeltas(prev, measureRows(root));
    for (const m of moved) {
      const el = els.get(m.id);
      if (el) play(el, [{ transform: `translate(${m.dx}px, ${m.dy}px)` }, { transform: "none" }], duration, easing);
    }
    for (const id of entered) {
      const el = els.get(id);
      if (el) play(el, [{ opacity: 0, transform: `translateY(-${ENTER_OFFSET}px)` }, { opacity: 1, transform: "none" }], duration, easing);
    }
  }, [signature, ref]);
}
