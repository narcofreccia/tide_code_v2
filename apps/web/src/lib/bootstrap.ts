import { TideConnection, createModelStore } from "@tide/client";
import { attachModelStore, setEnvironmentId, setRpcCaller, setRpcStreamer } from "../state/model.ts";

const TOKEN_KEY = "tide.devToken";
const URL_KEY = "tide.serverUrl";
const DEFAULT_URL = "ws://127.0.0.1:3777/ws";

/** `?server=` (the desktop shell's supervised server) > localStorage > build env. */
export function resolveServerUrl(): string {
  const fromQuery = new URL(window.location.href).searchParams.get("server");
  const fallback = import.meta.env.VITE_TIDE_URL || DEFAULT_URL;
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

/** `ws://host:port/ws` → `http://host:port`; `wss:` → `https:`. */
export function httpOriginFor(wsUrl: string): string {
  const url = new URL(wsUrl);
  const protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${protocol}//${url.host}`;
}

/**
 * Production auth: the raw token never travels on the WebSocket URL. It buys a
 * single-use ticket over HTTPS, which is what the socket presents.
 */
export function makeTicketGetter(wsUrl: string, token: string): () => Promise<string> {
  const origin = httpOriginFor(wsUrl);
  return async () => {
    const response = await fetch(`${origin}/api/auth/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error(`ws-ticket failed: ${response.status}`);
    const body = (await response.json()) as { ticket?: string };
    if (!body.ticket) throw new Error("ws-ticket response had no ticket");
    return body.ticket;
  };
}

export function startClient(): () => void {
  const url = resolveServerUrl();
  const token = resolveDevToken();
  // the server only accepts raw tokens on the socket in --dev
  const auth = import.meta.env.DEV
    ? ({ kind: "token", token } as const)
    : ({ kind: "ticket", getTicket: makeTicketGetter(url, token) } as const);
  const conn = new TideConnection({ url, auth });
  const store = createModelStore(conn);
  const detach = attachModelStore(store);
  setRpcCaller((method, params) => conn.call(method, params));
  setRpcStreamer((method, params, onChunk) => conn.stream(method, params, onChunk));

  conn.on("status", (status) => {
    if (status !== "open") return;
    conn
      .call("server.info", {})
      .then((info) => setEnvironmentId(info.environmentId))
      .catch(() => setEnvironmentId(null));
  });

  void conn.connect().catch(() => undefined);

  return () => {
    setRpcCaller(undefined);
    setRpcStreamer(undefined);
    detach();
    store.dispose();
    conn.close();
  };
}
