import { isTyping } from "../components/shell/useInboxKeys.ts";
import { isChord, parseChord } from "./keybindings.ts";

export const CHORD_WINDOW_MS = 1000;

export interface ChordBinding {
  id: string;
  /** `g m` form; non-chord bindings are ignored */
  binding: string;
  /** `false` = not applicable right now */
  run: () => boolean | void;
}

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "OS", "Hyper", "Super"]);

/**
 * Two-key go-to sequences. The first key arms the matcher for `CHORD_WINDOW_MS`; the
 * next key completes a chord or cancels. Never fires while a text field has focus or
 * with a modifier held.
 */
export function createChordMatcher(getBindings: () => ChordBinding[]) {
  let prefix: string | null = null;
  let at = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    prefix = null;
  };

  /** Returns true when the event was consumed (callers need not look at it again). */
  function handle(event: KeyboardEvent): boolean {
    if (MODIFIER_KEYS.has(event.key)) return false;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isTyping(event.target) || isTyping(document.activeElement)) {
      disarm();
      return false;
    }
    const key = event.key.toLowerCase();
    const chords = getBindings().filter((b) => isChord(b.binding));
    const armedWith = prefix;
    disarm();
    if (armedWith !== null) {
      const hit = chords.find((b) => {
        const [first, second] = parseChord(b.binding);
        return first === armedWith && second === key;
      });
      if (hit && hit.run() !== false) {
        event.preventDefault();
        return true;
      }
      // anything else cancels; the key itself may still start a new chord
      if (key === "escape") return false;
    }
    if (!chords.some((b) => parseChord(b.binding)[0] === key)) return false;
    prefix = key;
    at = Date.now();
    timer = setTimeout(disarm, CHORD_WINDOW_MS);
    event.preventDefault();
    return true;
  }

  return { handle, reset: disarm, get armed(): { prefix: string; at: number } | null { return prefix === null ? null : { prefix, at }; } };
}
