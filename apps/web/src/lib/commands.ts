import { useUi } from "../state/ui.ts";
import type { PaletteItem } from "./paletteItems.ts";

export const PALETTE_RECENTS_KEY = "tide.palette.recents";
const MAX_RECENTS = 12;

/** Ids of recently run palette items, most recent first. */
export function loadRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(PALETTE_RECENTS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function rememberRecent(id: string): string[] {
  const next = [id, ...loadRecents().filter((v) => v !== id)].slice(0, MAX_RECENTS);
  try {
    window.localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — recents are a convenience, not state */
  }
  return next;
}

export function openPalette(): void {
  useUi.getState().setPaletteOpen(true);
}

export function closePalette(): void {
  useUi.getState().setPaletteOpen(false);
}

/** Closes the palette, records the item and runs it. */
export function runPaletteItem(item: PaletteItem): void {
  closePalette();
  rememberRecent(item.id);
  item.run();
}
