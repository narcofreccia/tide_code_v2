import { httpOriginFor, routeFor, ticketGetter, wsUrlFor } from "@tide/client";
import { addEnvironment, setPrimaryEnvironment } from "../state/environments.ts";
import { startEnvironments } from "../state/envManager.ts";
import { loadProviders } from "../state/providers.ts";

export { httpOriginFor, wsUrlFor };

export const TOKEN_KEY = "tide.devToken";
export const URL_KEY = "tide.serverUrl";
const DEFAULT_URL = "ws://127.0.0.1:3777/ws";

/**
 * True when the page is served from Tauri's embedded asset origin: `tauri://localhost`
 * / `tide-shell://localhost` on macOS & Linux, or `http(s)://tauri.localhost` /
 * `http(s)://tide-shell.localhost` on Windows (WebView2).
 */
export function isTauriOrigin(location: { protocol: string; href: string }): boolean {
  if (location.protocol === "tauri:" || location.protocol === "tide-shell:") return true;
  try {
    const host = new URL(location.href).hostname.toLowerCase();
    return host === "tauri.localhost" || host === "tide-shell.localhost";
  } catch {
    return false;
  }
}

/**
 * Where to connect when nothing names a server: the build env, else — when the
 * page is served by tide-server itself (not the vite dev server, which lives on
 * another port) — the page's own origin, else the local default.
 */
export function defaultServerUrl(
  location: { protocol: string; href: string },
  env: { DEV: boolean; VITE_TIDE_URL?: string | undefined },
): string {
  if (env.VITE_TIDE_URL) return env.VITE_TIDE_URL;
  if (!env.DEV && !isTauriOrigin(location) && (location.protocol === "http:" || location.protocol === "https:")) {
    return wsUrlFor(location.href);
  }
  return DEFAULT_URL;
}

/**
 * The LOCAL environment's socket URL: `?server=` (the desktop shell's supervised server,
 * or a pairing link) > localStorage > derived default. R9: it only ever names the local
 * environment; the user's other environments live in `tide.environments.v1`.
 */
export function resolveServerUrl(): string {
  const params = new URL(window.location.href).searchParams;
  const fromQuery = params.get("server");
  const fallback = defaultServerUrl(window.location, import.meta.env);
  // R17: a remote launch's `?server=` names another machine, never the local server
  if (params.get("remote") === "1") return fromQuery ?? "";
  try {
    if (fromQuery) window.localStorage.setItem(URL_KEY, fromQuery);
    else return window.localStorage.getItem(URL_KEY) || fallback;
  } catch {
    /* storage may be unavailable */
  }
  return fromQuery || fallback;
}

/**
 * Dev token precedence: `?token=` in the page URL (persisted, then stripped from
 * history so it does not linger in the address bar) > localStorage > build env.
 */
export function resolveDevToken(): string {
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get("token");
  url.searchParams.delete("server");
  if (fromQuery) {
    try {
      window.localStorage.setItem(TOKEN_KEY, fromQuery);
    } catch {
      /* storage may be unavailable; the in-memory token still works */
    }
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    return fromQuery;
  }
  try {
    const stored = window.localStorage.getItem(TOKEN_KEY);
    if (stored) return stored;
  } catch {
    /* ignore */
  }
  return import.meta.env.VITE_TIDE_TOKEN ?? "";
}

/**
 * Production auth: the raw token never travels on the WebSocket URL. It buys a
 * single-use ticket over HTTPS, which is what the socket presents.
 */
export function makeTicketGetter(wsUrl: string, token: string): () => Promise<string> {
  return ticketGetter(httpOriginFor(wsUrl), token);
}

/**
 * The page URL another device opens to reach this server: the server's own
 * `http://` origin, told where the socket is with `?server=`.
 */
export function pairingPageUrl(lanUrl: string): string {
  const page = new URL(lanUrl);
  page.pathname = "/";
  // `paired` tells isDesktop() this `?server=` came from a pairing link, not the shell
  page.search = `?server=${encodeURIComponent(wsUrlFor(lanUrl))}&paired=1`;
  return page.toString();
}

/**
 * R9: "connect to another server" adds it as an environment and makes it the primary;
 * the local environment and every other one stay connected. Drops a `?server=` /
 * `?token=` hand-off from the address bar so a reload does not re-apply it.
 */
export async function connectTo(serverUrl: string, token: string): Promise<string> {
  const url = new URL(window.location.href);
  url.searchParams.delete("server");
  url.searchParams.delete("token");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  const id = await addEnvironment({ routes: [routeFor(serverUrl)], token });
  setPrimaryEnvironment(id);
  loadProviders(true);
  return id;
}

/**
 * R17: the desktop shell opened another machine (`?server=&token=&remote=1[&clientId=]`).
 * Its token is that machine's per-device token, so it is not stored as the local dev token;
 * the hand-off is stripped from history but `remote=1` stays, so a reload still skips the
 * local server (the machine itself is persisted in the environment list).
 */
export function resolveRemoteLaunch(): { url: string; token: string; clientId?: string } | null {
  const url = new URL(window.location.href);
  if (url.searchParams.get("remote") !== "1") return null;
  const launch = { url: resolveServerUrl(), token: url.searchParams.get("token") ?? "" };
  const clientId = url.searchParams.get("clientId");
  for (const key of ["server", "token", "clientId"]) url.searchParams.delete(key);
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  return clientId ? { ...launch, clientId } : launch;
}

/**
 * Boots the environment manager: the legacy `?server=` / `?token=` / VITE_TIDE_URL /
 * stored URL resolve to the LOCAL environment's route and token; user-added
 * environments and the primary choice come from `tide.environments.v1` untouched.
 * A remote launch (`?remote=1`) synthesises no local environment.
 */
export function startClient(): () => void {
  const remote = resolveRemoteLaunch();
  if (remote) return startEnvironments({ ...remote, remote: true });
  return startEnvironments({ url: resolveServerUrl(), token: resolveDevToken() });
}

// ---- desktop shell detection ----

export type DesktopPlatform = "mac" | "win" | "linux";

const DESKTOP_KEY = "tide.desktop";

/** Coarse platform bucket; only used to decide chrome insets, never behaviour. */
export function platformOf(ua: string): DesktopPlatform {
  if (/mac|iphone|ipad/i.test(ua)) return "mac";
  if (/win/i.test(ua)) return "win";
  return "linux";
}

/**
 * The page is running inside the Tauri shell when it was handed off with
 * `?server=` or is served over the shell's own protocol. The answer is sticky:
 * the shell strips the query on later navigations, so it is persisted once.
 */
export function isDesktop(): boolean {
  if (isTauriOrigin(window.location)) return true;
  const params = new URL(window.location.href).searchParams;
  if (params.has("server") && !params.has("paired")) return true;
  try {
    return window.localStorage.getItem(DESKTOP_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Stamps `data-desktop` on `<html>` so the chrome can reserve room for native
 * window controls (`styles/tokens.css` + `TopBar.module.css` key off it).
 * No Tauri imports: the browser build stays real.
 */
export function applyDesktopFlag(): DesktopPlatform | null {
  if (!isDesktop()) return null;
  const platform = platformOf(window.navigator.userAgent);
  try {
    window.localStorage.setItem(DESKTOP_KEY, "1");
  } catch {
    /* storage may be unavailable; the attribute still applies for this load */
  }
  document.documentElement.dataset.desktop = platform;
  return platform;
}

// ---- desktop shell actions ----

export type SplashAction = "connect" | "local";

/**
 * The shell's splash page for a page on the shell's app origin: `tauri://localhost` →
 * `tide-shell://localhost/` (macOS & Linux), `http(s)://tauri.localhost` →
 * `http(s)://tide-shell.localhost/` (Windows). Anything else (a browser, vite dev, a page
 * served by tide-server) has no splash: `null`.
 */
export function splashBaseFor(location: { protocol: string; href: string }): string | null {
  if (location.protocol === "tauri:") return "tide-shell://localhost/";
  if (location.protocol !== "http:" && location.protocol !== "https:") return null;
  try {
    if (new URL(location.href).hostname.toLowerCase() !== "tauri.localhost") return null;
  } catch {
    return null;
  }
  return `${location.protocol}//tide-shell.localhost/`;
}

/**
 * The splash URL that performs a shell action: `connect` opens its pairing form, `local`
 * switches the shell back to its own server. The theme rides along as the shell passes it.
 */
export function splashUrlFor(action: SplashAction, location: { protocol: string; href: string }, theme: string): string | null {
  const base = splashBaseFor(location);
  if (base === null) return null;
  return `${base}?theme=${encodeURIComponent(theme || "system")}&${action}=1`;
}

/** R17: the shell opened another machine; `remote=1` stays in the URL for the page's life. */
export function isRemoteLaunch(location: { href: string }): boolean {
  try {
    return new URL(location.href).searchParams.get("remote") === "1";
  } catch {
    return false;
  }
}

/** Leaves the app for the shell's splash page (a URL from `splashUrlFor`), which does the rest. */
export function openSplash(url: string): void {
  window.location.assign(url);
}

/** The current theme as the shell hands it to the splash. */
export function currentTheme(): string {
  return document.documentElement.dataset.theme || "system";
}
