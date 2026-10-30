import { useEffect } from "react";
import { canUndoSettle, settleToastLive, undoLastSettle } from "../../lib/inboxActions.ts";
import { matchRailBinding } from "../../lib/keybindings.ts";
import { canMergeBack, mergeBackThread, settleThread, unsettleThread } from "../../lib/threadActions.ts";
import { useModel } from "../../state/model.ts";
import { clearRailSelection, requestRailSnooze, toggleRailSelected, useRailSelection } from "../../state/railSelection.ts";
import { resetRailSearch, useRailSearch } from "../../state/railSearch.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { useUi } from "../../state/ui.ts";

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

/** The rail's row buttons in visible order. */
function railRows(): HTMLElement[] {
  const nav = document.querySelector('nav[aria-label="Navigation"]');
  if (nav === null) return [];
  return Array.from(nav.querySelectorAll<HTMLElement>("[data-rail-thread] > [data-rail-main]"));
}

/** The thread of the focused rail row, if focus is on one. */
export function focusedRailThread(): string | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return undefined;
  if (active.closest('nav[aria-label="Navigation"]') === null) return undefined;
  return active.closest<HTMLElement>("[data-rail-thread]")?.dataset.railThread;
}

/** j/k: from the focused row, else from the open thread's row, else from the top. */
function moveFocus(step: 1 | -1): boolean {
  const rows = railRows();
  if (rows.length === 0) return false;
  const focused = focusedRailThread();
  const from = focused ?? useUi.getState().selectedThreadId ?? undefined;
  const at = from === undefined ? -1 : rows.findIndex((r) => r.parentElement?.dataset.railThread === from);
  const next = at < 0 ? (step === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + (focused === undefined ? 0 : step)));
  rows[next]?.focus();
  return true;
}

/** Runs a single-key rail action; false when it does not apply right now. */
function runRailKey(id: NonNullable<ReturnType<typeof matchRailBinding>>): boolean {
  if (id === "rail.search") {
    const field = document.querySelector<HTMLInputElement>("[data-rail-search]");
    if (field === null) return false;
    field.focus();
    return true;
  }
  if (id === "rail.next") return moveFocus(1);
  if (id === "rail.prev") return moveFocus(-1);
  const threadId = focusedRailThread();
  if (threadId === undefined) return false;
  const thread = useModel.getState().model.threads[threadId];
  if (thread === undefined) return false;
  switch (id) {
    case "rail.open":
      useUi.getState().selectThread(threadId);
      return true;
    case "rail.settle":
      if (thread.archivedAt !== undefined) return false;
      if (thread.settledAt !== undefined) unsettleThread(threadId);
      else settleThread(threadId);
      return true;
    case "rail.snooze":
      if (thread.archivedAt !== undefined) return false;
      requestRailSnooze(threadId);
      return true;
    case "rail.merge":
      if (thread.archivedAt !== undefined || !canMergeBack(thread)) return false;
      void mergeBackThread(threadId);
      return true;
    case "rail.select":
      toggleRailSelected(threadId);
      return true;
  }
}

/**
 * The inbox's keys, mounted once by the rail. Never while a text field has focus.
 * - ⌘Z / Ctrl+Z undoes the newest settle while its toast is up, or while focus is
 *   in the rail / thread column.
 * - Esc clears the rail search first, then the multi-selection.
 * - Single keys (rebindable, `lib/keybindings.ts` RAIL_BINDINGS): `/` search,
 *   `j`/`k` move, `↵` open, `e` settle, `s` snooze, `m` merge back, `x` select.
 */
export function useInboxKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (isTyping(event.target) || isTyping(document.activeElement)) return;
      if (event.key === "Escape") {
        if (useRailSearch.getState().query !== "") {
          resetRailSearch();
          return;
        }
        if (useRailSelection.getState().ids.length === 0) return;
        clearRailSelection();
        return;
      }
      const undoKey = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z";
      if (undoKey) {
        if (!canUndoSettle()) return;
        if (!settleToastLive() && !focusAllowsUndo(document.activeElement)) return;
        event.preventDefault();
        undoLastSettle();
        return;
      }
      const overrides = useServerSettings.getState().settings.keybindings ?? {};
      const id = matchRailBinding(event, overrides);
      if (id === undefined) return;
      // a dialog or menu has the keys
      if (document.querySelector('[role="dialog"], [role="menu"]') !== null) return;
      if (runRailKey(id)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
