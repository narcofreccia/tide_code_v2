import type { EnvRoute } from "@tide/contracts";

/** `http://host:port` → `ws://host:port/ws`; `https:` → `wss:`. */
export function wsUrlFor(httpUrl: string): string {
  const url = new URL(httpUrl);
  const protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  return `${protocol}//${url.host}/ws`;
}

/** `ws://host:port/ws` → `http://host:port`; `wss:` → `https:`. */
export function httpOriginFor(wsUrl: string): string {
  const url = new URL(wsUrl);
  const protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${url.host}`;
}

const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./];

/**
 * Route kind for a URL the user typed or paired with. `local` is never inferred: it marks the
 * environment this client was launched against (desktop sidecar / page origin) and is set explicitly.
 */
export function routeKindFor(url: string): EnvRoute["kind"] {
  const host = new URL(url).hostname.toLowerCase();
  if (host.endsWith(".ts.net")) return "tailscale";
  // tailscale's CGNAT range
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return "tailscale";
  if (PRIVATE_V4.some((re) => re.test(host)) || host.endsWith(".local")) return "lan";
  return "custom";
}

/** Lower priority value is tried first: loopback, LAN, tailscale, ssh tunnel, custom, relay. */
export const ROUTE_PRIORITY: Record<EnvRoute["kind"], number> = {
  local: 0,
  lan: 10,
  tailscale: 20,
  ssh: 30,
  custom: 40,
  relay: 50,
};

export function routeFor(url: string, kind: EnvRoute["kind"] = routeKindFor(url)): EnvRoute {
  return { kind, url, priority: ROUTE_PRIORITY[kind] };
}

export function sortRoutes(routes: readonly EnvRoute[]): EnvRoute[] {
  return [...routes].sort((a, b) => a.priority - b.priority);
}
