import { useEffect } from "react";
import { useMarkSeen } from "../shell/useMarkSeen.ts";

/**
 * Behaviour the desktop Rail owns that the phone shell must keep (the open thread counts as
 * seen), plus `--app-h`: the visual viewport height, so the layout shrinks above the keyboard.
 */
export function PhoneEffects() {
  useMarkSeen();
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const sync = (): void => root.style.setProperty("--app-h", `${vv.height}px`);
    sync();
    vv.addEventListener("resize", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      root.style.removeProperty("--app-h");
    };
  }, []);
  return null;
}
