import { useSyncExternalStore } from "react";

/** Phone shell breakpoint: the single-column stack at or below this width. */
export const PHONE_MAX_WIDTH = 720;
const QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

export interface Viewport {
  phone: boolean;
  width: number;
}

function matcher(): MediaQueryList | undefined {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : undefined;
}

function subscribe(notify: () => void): () => void {
  const mql = matcher();
  window.addEventListener("resize", notify);
  mql?.addEventListener("change", notify);
  return () => {
    window.removeEventListener("resize", notify);
    mql?.removeEventListener("change", notify);
  };
}

let cached: Viewport = { phone: false, width: 1024 };
function snapshot(): Viewport {
  const phone = matcher()?.matches ?? false;
  const width = typeof window === "undefined" ? 1024 : window.innerWidth;
  if (cached.phone !== phone || cached.width !== width) cached = { phone, width };
  return cached;
}

/** Non-hook read of the same phone query, for code outside React (stores, actions). */
export function isPhoneViewport(): boolean {
  return matcher()?.matches ?? false;
}

/** `{ phone, width }` from `matchMedia("(max-width: 720px)")`; desktop when matchMedia is unavailable. */
export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
