import { create } from "zustand";
import type { SearchHit } from "@tide/contracts";
import { SEARCH_DEBOUNCE_MS, searchServer } from "./railSearch.ts";

/** ⌘K message search: the server is asked once the query has this many characters. */
export const PALETTE_SEARCH_MIN_CHARS = 3;

interface PaletteSearchState {
  q: string;
  /** message-text hits for `q`; title hits are already Go-to items */
  hits: SearchHit[];
  generation: number;
}

export const usePaletteSearch = create<PaletteSearchState>(() => ({ q: "", hits: [], generation: 0 }));

let timer: ReturnType<typeof setTimeout> | undefined;

export function setPaletteQuery(q: string): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  const mine = usePaletteSearch.getState().generation + 1;
  const text = q.trim();
  if (text.length < PALETTE_SEARCH_MIN_CHARS) {
    usePaletteSearch.setState({ q, hits: [], generation: mine });
    return;
  }
  usePaletteSearch.setState({ q, generation: mine });
  timer = setTimeout(() => {
    timer = undefined;
    void searchServer(text, null).then((hits) => {
      if (usePaletteSearch.getState().generation !== mine) return;
      usePaletteSearch.setState({ hits: hits.filter((h) => h.field === "message") });
    });
  }, SEARCH_DEBOUNCE_MS);
}

export function resetPaletteSearch(): void {
  setPaletteQuery("");
}
