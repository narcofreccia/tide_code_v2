/** What the service worker does with a request. Pure, so it is unit-tested without a worker. */
export type CacheStrategy = "cache-first" | "network-first" | "bypass";

/** Live channels and server routes: never cached, never intercepted. */
const NEVER = [/^\/ws(\/|$)/, /^\/api(\/|$)/, /^\/hook(\/|$)/];

/**
 * `/assets/*` is content-hashed by Vite, so a hit never goes stale: cache-first.
 * Everything else on the same origin (the shell, manifest, icons) is network-first
 * with the cache as the offline fallback. Cross-origin and non-GET are left alone.
 */
export function strategyFor(url: URL, method: string, origin: string): CacheStrategy {
  if (method !== "GET") return "bypass";
  if (url.origin !== origin) return "bypass";
  if (NEVER.some((re) => re.test(url.pathname))) return "bypass";
  if (url.pathname.startsWith("/assets/")) return "cache-first";
  return "network-first";
}

const CACHE_PREFIX = "tide-shell-";

/** The per-build cache name; an older name is deleted on activate. */
export function cacheName(buildId: string): string {
  return `${CACHE_PREFIX}${buildId}`;
}

/** Any build's cache, current or not (the desktop shell retires them all). */
export function isShellCache(name: string): boolean {
  return name.startsWith(CACHE_PREFIX);
}

export function isStaleCache(name: string, current: string): boolean {
  return isShellCache(name) && name !== current;
}
