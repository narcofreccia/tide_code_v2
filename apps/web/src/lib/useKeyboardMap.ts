import { useEffect } from "react";
import { useServerSettings } from "../state/serverSettings.ts";
import { createChordMatcher, type ChordBinding } from "./chords.ts";
import { SHORTCUTS, defaultBinding, handleShortcut, scopeApplies } from "./shortcuts.ts";

function liveChords(): ChordBinding[] {
  const overrides = useServerSettings.getState().settings.keybindings ?? {};
  const out: ChordBinding[] = [];
  for (const s of SHORTCUTS) {
    const run = s.run;
    const binding = overrides[s.id] || defaultBinding(s);
    if (!run || !binding || !scopeApplies(s.when)) continue;
    out.push({ id: s.id, binding, run });
  }
  return out;
}

/** Binds the global keyboard map; every binding lives in `lib/shortcuts.ts`. */
export function useKeyboardMap(): void {
  useEffect(() => {
    const chords = createChordMatcher(liveChords);
    // capture phase: a consumed key is preventDefault-ed before the rail's bare-key handler (which skips defaultPrevented) sees it
    const onChord = (event: KeyboardEvent): void => {
      chords.handle(event);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (handleShortcut(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onChord, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      chords.reset();
      window.removeEventListener("keydown", onChord, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
