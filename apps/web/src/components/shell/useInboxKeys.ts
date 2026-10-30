import { useEffect } from "react";
import { canUndoSettle, settleToastLive, undoLastSettle } from "../../lib/inboxActions.ts";
import { clearRailSelection, useRailSelection } from "../../state/railSelection.ts";

/** True when keys belong to a text field (composer, rename, Monaco's textarea, terminal). */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Focus sits somewhere ⌘Z can only mean "undo the settle": nowhere, the rail, or the thread column. */
function focusAllowsUndo(active: Element | null): boolean {
  if (active === null || active === document.body) return true;
  return active.closest('nav[aria-label="Navigation"]') !== null || active.closest("[data-thread-column]") !== null;
}

/**
 * The inbox's keys, mounted once by the rail:
 * - ⌘Z / Ctrl+Z undoes the newest settle while its toast is up, or while focus is
 *   in the rail / thread column; never while a text field has focus.
 * - Esc clears the rail's multi-selection.
 */
export function useInboxKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTyping(event.target) || isTyping(document.activeElement)) return;
      if (event.key === "Escape") {
        if (useRailSelection.getState().ids.length === 0) return;
        clearRailSelection();
        return;
      }
      const undoKey = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z";
      if (!undoKey || !canUndoSettle()) return;
      if (!settleToastLive() && !focusAllowsUndo(document.activeElement)) return;
      event.preventDefault();
      undoLastSettle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
