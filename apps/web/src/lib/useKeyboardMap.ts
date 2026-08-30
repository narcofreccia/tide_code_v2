import { useEffect } from "react";
import { handleShortcut } from "./shortcuts.ts";

/** Binds the global keyboard map; every binding lives in `lib/shortcuts.ts`. */
export function useKeyboardMap(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (handleShortcut(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
