/**
 * R19: is the connection to a machine encrypted? A route URL (`ws://`, `wss://`, `http(s)://`)
 * is `encrypted` over TLS (wss/https, which includes relay routes: encrypted in transit, though
 * the relay itself can read the traffic), `local` when it stays on this computer (loopback), and
 * `plain` otherwise: plain HTTP over a network, readable by anyone on it.
 */
export type RouteSecurity = "encrypted" | "local" | "plain";

export const NOT_ENCRYPTED_LABEL = "Not encrypted";
export const NOT_ENCRYPTED_TIP = "This connection is plain HTTP. Anyone on the same network can read it. Use Tailscale or give the server a certificate.";
export const MIXED_CONTENT_REASON = "This page is HTTPS and cannot reach a machine over plain HTTP. Give that machine a certificate or open Tide over HTTP.";

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "::1" || host === "0:0:0:0:0:0:0:1";
}

export function routeSecurity(url: string): RouteSecurity {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "plain";
  }
  if (parsed.protocol === "wss:" || parsed.protocol === "https:") return "encrypted";
  return isLoopbackHost(parsed.hostname) ? "local" : "plain";
}

/** The protocol of the page running this client (`https:` / `http:` / `tauri:`), "" outside a browser. */
export function pageProtocol(): string {
  return (globalThis as { location?: { protocol?: string } }).location?.protocol ?? "";
}

/**
 * True when the browser will refuse this route as mixed content: the page is HTTPS and the
 * route is plain to another machine. Loopback stays reachable (browsers treat it as trustworthy).
 */
export function mixedContentBlocked(url: string, protocol: string = pageProtocol()): boolean {
  return protocol === "https:" && routeSecurity(url) === "plain";
}

/** The reason a machine is unreachable when every one of its routes is blocked as mixed content. */
export function mixedContentReason(routes: readonly { url: string }[], protocol: string = pageProtocol()): string | undefined {
  return routes.length > 0 && routes.every((r) => mixedContentBlocked(r.url, protocol)) ? MIXED_CONTENT_REASON : undefined;
}
