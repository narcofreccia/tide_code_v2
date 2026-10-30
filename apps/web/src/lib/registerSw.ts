import { showToast } from "../state/toast.ts";

/**
 * Registers `/sw.js` (production builds only: Vite dev must never be cached).
 * The worker skips waiting, so a deploy swaps the controller under an open tab;
 * that is the cue for the "new version" toast.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const hadController = navigator.serviceWorker.controller !== null;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    showToast("New version available", { label: "Reload", onClick: () => { reloaded = true; window.location.reload(); } }, { ms: 30_000 });
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { type: "module" }).catch(() => undefined);
  });
}
