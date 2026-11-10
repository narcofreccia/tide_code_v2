import { isIP } from "node:net";
import { hostname as osHostname } from "node:os";

/**
 * R18: Host and Origin rules for the HTTP/WS listener.
 *
 * Host (DNS-rebinding defence). A rebinding page keeps its own name (`evil.example`) while the
 * name starts resolving to this machine, so the browser sends `Host: evil.example`. Refusing
 * names we do not know blocks it. IP literals are always accepted: a page cannot make the
 * browser send an IP-literal Host without its URL being that IP, which makes it an ordinary
 * cross-origin request (the Origin rules and the tokens apply). Accepted names: loopback
 * (`localhost`, `*.localhost`), this machine's hostname and `<hostname>.local`, the name the mDNS
 * responder advertises (`tide-<id>.local`), its Tailscale name (`<hostname>.<tailnet>.ts.net`), and `TIDE_ALLOWED_HOSTS` (comma-separated, `*` turns
 * the check off). A request without a Host header (HTTP/1.0 tools) is accepted.
 *
 * Origin. Token-bearing requests come legitimately from many origins (another machine's dev
 * server, its Tauri shell, the page its own tide-server serves), so they are not origin-checked:
 * the bearer token is the guard. The unauthenticated endpoints that change state
 * (`POST /api/auth/pair`, `POST /hook/<id>`) refuse a browser request from a page that could be
 * on the public web. Rule (`trustedOrigin`):
 *   - no Origin header: accepted (curl, the CLI, webhook senders, tide-mcp);
 *   - `null` or unparseable: refused (a sandboxed iframe on any site sends `null`);
 *   - a scheme other than http(s) (`tauri://localhost`, app schemes): accepted, a web page
 *     cannot have one;
 *   - http(s) whose host is loopback, `*.localhost` (also `tauri.localhost`), a private,
 *     link-local or CGNAT/Tailscale IP literal, a `*.local` name or a single-label name:
 *     accepted, none of these is reachable as a public web page from the browser's side;
 *   - the request's own Host (a page this server served), a TIDE_ALLOWED_HOSTS name, a
 *     configured CORS origin (TIDE_CORS_ORIGINS, the dev server) or the configured relay's
 *     origin (the web client served through the relay): accepted;
 *   - anything else (a public domain or public IP literal): refused.
 * The same rule decides which origins get their Origin echoed in CORS answers on the public
 * probe routes, so a public page can no longer read `/api/env` from a LAN server.
 */

export const ALLOWED_HOSTS_ENV = "TIDE_ALLOWED_HOSTS";

/** `TIDE_ALLOWED_HOSTS=a.example, b:3777` → ["a.example", "b"] (ports and case dropped). */
export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (s === "*" ? s : (hostnameOf(s) ?? s.toLowerCase())));
}

/** The name part of a Host header (`[::1]:3777` → `::1`, `Box.Local.:80` → `box.local`). */
export function hostnameOf(host: string): string | undefined {
  const value = host.trim().toLowerCase();
  if (value === "") return undefined;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 1 ? value.slice(1, end) : undefined;
  }
  // a bare IPv6 literal without brackets (not valid in Host, but cheap to read)
  if (isIP(value) === 6) return value;
  const name = value.replace(/:\d*$/, "");
  return name.replace(/\.$/, "") || undefined;
}

const isLoopbackName = (name: string): boolean => name === "localhost" || name.endsWith(".localhost");

function isLoopbackIp(ip: string): boolean {
  if (isIP(ip) === 4) return ip.startsWith("127.");
  return ip === "::1" || ip === "0:0:0:0:0:0:0:1" || /^::ffff:127\./.test(ip);
}

/** RFC 1918, link-local, CGNAT (Tailscale's 100.64/10), IPv6 ULA and link-local. */
export function isPrivateIp(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
  const v4 = mapped ?? (isIP(ip) === 4 ? ip : undefined);
  if (v4 !== undefined) {
    const [a = 0, b = 0] = v4.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(ip) !== 6) return false;
  return isLoopbackIp(ip) || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
}

/** Same short id as the mDNS responder's host name (`apps/server/src/rpc/mdns/responder.ts`). */
export function mdnsHostName(environmentId: string): string {
  return `tide-${environmentId.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase() || "tide"}.local`;
}

export interface HostPolicyOptions {
  environmentId: string;
  /** TIDE_ALLOWED_HOSTS, parsed */
  allowedHosts?: string[];
  /** read per call: the user may rename the machine while the server runs */
  hostname?: () => string;
}

export interface HostPolicy {
  /** the Host header is one this server answers to */
  allowsHost(host: string | undefined): boolean;
  /** a hostname named in TIDE_ALLOWED_HOSTS */
  isAllowedName(name: string): boolean;
}

export function createHostPolicy(options: HostPolicyOptions): HostPolicy {
  const allowed = new Set(options.allowedHosts ?? []);
  const mdns = mdnsHostName(options.environmentId);
  const machine = options.hostname ?? (() => osHostname());
  const isAllowedName = (name: string): boolean => allowed.has("*") || allowed.has(name);
  return {
    isAllowedName,
    allowsHost(host) {
      if (host === undefined || host.trim() === "") return true;
      const name = hostnameOf(host);
      if (name === undefined) return false;
      if (isIP(name) !== 0 || isLoopbackName(name) || name === mdns || isAllowedName(name)) return true;
      const own = machine().toLowerCase().replace(/\.$/, "");
      const short = own.replace(/\.local$/, "");
      if (name === own || name === short || name === `${short}.local`) return true;
      // Tailscale MagicDNS: `<machine>.<tailnet>.ts.net` (only this machine's own label)
      return name.endsWith(".ts.net") && name.split(".")[0] === short.split(".")[0];
    },
  };
}

/** One line for a refused Host: what to set to allow the name. */
export function hostRefusal(host: string | undefined): string {
  const name = host === undefined ? "" : (hostnameOf(host) ?? host);
  return `tide-server: host "${name}" is not allowed; to reach this server by that name, add it to ${ALLOWED_HOSTS_ENV} (comma-separated) and restart\n`;
}

export interface OriginContext {
  /** the request's Host header (already accepted by the host policy) */
  host: string | undefined;
  hosts: HostPolicy;
  /** exact origins from config.corsOrigins (TIDE_CORS_ORIGINS, the dev server) */
  corsOrigins: readonly string[];
  /** `https://relay.example` when a relay is configured */
  relayOrigin: string | undefined;
}

/** True when a browser request with this Origin may drive an unauthenticated endpoint (rule above). */
export function trustedOrigin(origin: string | undefined, ctx: OriginContext): boolean {
  if (origin === undefined) return true;
  if (origin === "null") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  if (ctx.corsOrigins.includes(origin) || (ctx.relayOrigin !== undefined && url.origin === ctx.relayOrigin)) return true;
  const name = hostnameOf(url.host);
  if (name === undefined) return false;
  if (isLoopbackName(name) || ctx.hosts.isAllowedName(name)) return true;
  if (isIP(name) !== 0) {
    if (isPrivateIp(name)) return true;
  } else if (name.endsWith(".local") || !name.includes(".")) return true;
  // a page this server served itself: the origin's host is the request's Host
  return ctx.host !== undefined && url.host === ctx.host.trim().toLowerCase();
}

/** `https://relay.example/c/<env>` or `wss://relay.example` → `https://relay.example`. */
export function relayOriginOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url.trim().replace(/^ws(s?):\/\//i, "http$1://")).origin;
  } catch {
    return undefined;
  }
}
