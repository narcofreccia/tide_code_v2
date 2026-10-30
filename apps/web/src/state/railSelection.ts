import { create } from "zustand";

/**
 * Rail multi-select: ⌘-click toggles a row, shift-click extends from the anchor,
 * Esc clears. Per session, never persisted.
 */
interface RailSelectionState {
  ids: string[];
  /** the last plainly or ⌘-clicked row: where a shift-click range starts */
  anchor: string | null;
}

export const useRailSelection = create<RailSelectionState>(() => ({ ids: [], anchor: null }));

export function toggleRailSelected(id: string): void {
  useRailSelection.setState((s) => ({
    ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id],
    anchor: id,
  }));
}

/**
 * Selects the rows between the anchor and `id` in `order` (the rail's visible
 * order). Without an anchor in `order` it selects `id` alone.
 */
export function selectRailRange(id: string, order: readonly string[]): void {
  const { anchor, ids } = useRailSelection.getState();
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(id);
  if (from < 0 || to < 0) {
    useRailSelection.setState({ ids: [id], anchor: id });
    return;
  }
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const range = order.slice(lo, hi + 1);
  useRailSelection.setState({ ids: [...new Set([...ids, ...range])], anchor });
}

/** A plain click: the anchor moves, the selection goes. */
export function setRailAnchor(id: string): void {
  useRailSelection.setState({ ids: [], anchor: id });
}

export function clearRailSelection(): void {
  useRailSelection.setState({ ids: [], anchor: null });
}
