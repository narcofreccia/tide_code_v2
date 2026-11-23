import { showToast } from "../state/toast.ts";
import { isShellCache } from "../sw/policy.ts";
import { isTauriOrigin } from "./bootstrap.ts";

/** What registration touches, injectable so tests run without a real worker. */
export type SwEnv = {
  location: { protocol: string; href: string };
  serviceWorker: ServiceWorkerContainer | undefined;
  caches: CacheStorage | undefined;
  onLoad: (run: () => void) => void;
  reload: () => void;
};

function browserEnv(): SwEnv {
  return {
    location: window.location,
    serviceWorker: typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
    caches: typeof caches === "undefined" ? undefined : caches,
    onLoad: (run) => window.addEventListener("load", run),
    reload: () => window.location.reload(),
  };
}

/**
 * Registers `/sw.js` (production builds only: Vite dev must never be cached).
 * The worker skips waiting, so a deploy swaps the controller under an open tab;
 * that is the cue for the "new version" toast.
 *
 * Inside the desktop shell there is no server behind the page's origin and the shell
 * already ships every asset, so no worker runs there; whatever an earlier build left
 * registered (Windows' `http://tauri.localhost` is a secure origin) is retired instead.
 */
export function registerServiceWorker(env: SwEnv = browserEnv()): Promise<void> {
  if (isTauriOrigin(env.location)) return retireServiceWorkers(env);
  const sw = env.serviceWorker;
  if (sw === undefined) return Promise.resolve();
  const hadController = sw.controller !== null;
  let reloaded = false;
  sw.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    showToast("New version available", { label: "Reload", onClick: () => { reloaded = true; env.reload(); } }, { ms: 30_000 });
  });
  env.onLoad(() => {
    sw.register("/sw.js", { type: "module" }).catch(() => undefined);
  });
  return Promise.resolve();
}

/** Best effort: unregisters every worker and drops every Tide cache. Never rejects. */
export async function retireServiceWorkers(env: Pick<SwEnv, "serviceWorker" | "caches">): Promise<void> {
  await Promise.all([unregisterAll(env.serviceWorker), dropShellCaches(env.caches)]);
}

async function unregisterAll(sw: ServiceWorkerContainer | undefined): Promise<void> {
  if (sw === undefined) return;
  try {
    const registrations = await sw.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister().catch(() => false)));
  } catch {
    /* nothing to retire, or the container refused */
  }
}

async function dropShellCaches(store: CacheStorage | undefined): Promise<void> {
  if (store === undefined) return;
  try {
    const names = await store.keys();
    await Promise.all(names.filter(isShellCache).map((name) => store.delete(name).catch(() => false)));
  } catch {
    /* Cache Storage unavailable */
  }
}
