import { useEffect, useRef } from "react";

/**
 * Runs `onReturn` when the user comes back to the window: it regains focus, or the tab becomes
 * visible again. One pair of listeners while `enabled`; no timers. Used where something may have
 * changed outside the app while the user was away (a harness installed in a terminal, Full access
 * turned on for this device on the machine itself).
 */
export function useWindowReturn(onReturn: () => void, enabled = true): void {
  const latest = useRef(onReturn);
  latest.current = onReturn;
  useEffect(() => {
    if (!enabled) return undefined;
    const back = (): void => {
      if (document.visibilityState === "hidden") return;
      latest.current();
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [enabled]);
}
