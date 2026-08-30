import { useEffect } from "react";
import { useUi } from "../state/ui.ts";
import { closeActiveTab, openSearchTab, setQuickOpen, toggleTree } from "../state/workbench.ts";
import { toggleDrawer } from "../state/terminals.ts";

/**
 * Global shortcuts: ⌘0 Mission Control · ⌘1/2/3 focus modes · ⌘B rail ·
 * ⌘⇧D diff layout · ⌘P open file · ⌘⇧F search · ⌘⇧E tree · ⌘W close tab · ⌘` terminal.
 */
export function useKeyboardMap(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey && !event.ctrlKey) return;
      const ui = useUi.getState();
      const threadId = ui.selectedThreadId;
      switch (event.key) {
        case "0":
          ui.showMission();
          break;
        case "1":
          ui.setFocusMode("thread");
          break;
        case "2":
          ui.setFocusMode("split");
          break;
        case "3":
          ui.setFocusMode("workbench");
          break;
        case "b":
        case "B":
          if (event.shiftKey) return;
          ui.toggleRail();
          break;
        case "d":
        case "D":
          if (!event.shiftKey) return;
          ui.toggleDiffSideBySide();
          break;
        case "p":
        case "P":
          if (event.shiftKey || !threadId) return;
          setQuickOpen(true);
          break;
        case "f":
        case "F":
          if (!event.shiftKey || !threadId) return;
          openSearchTab(threadId);
          if (ui.focusMode === "thread") ui.setFocusMode("split");
          break;
        case "e":
        case "E":
          if (!event.shiftKey) return;
          toggleTree();
          break;
        case "w":
        case "W":
          if (event.shiftKey || !threadId) return;
          closeActiveTab(threadId);
          break;
        case "`":
          if (!threadId) return;
          toggleDrawer();
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
