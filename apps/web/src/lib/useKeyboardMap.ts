import { useEffect } from "react";
import { useUi } from "../state/ui.ts";

/** Global shortcuts: ⌘0 Mission Control · ⌘1/2/3 focus modes · ⌘B rail. */
export function useKeyboardMap(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey && !event.ctrlKey) return;
      const ui = useUi.getState();
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
          ui.toggleRail();
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
