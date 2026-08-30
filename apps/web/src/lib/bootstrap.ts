import { TideConnection, createModelStore } from "@tide/client";
import { attachModelStore, setEnvironmentId } from "../state/model.ts";

const TOKEN_KEY = "tide.devToken";
const DEFAULT_URL = "ws://127.0.0.1:3777/ws";

/**
 * Dev token precedence: `?token=` in the page URL (persisted, then stripped from
 * history so it does not linger in the address bar) > localStorage > build env.
 */
export function resolveDevToken(): string {
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get("token");
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

export function startClient(): () => void {
  const conn = new TideConnection({
    url: import.meta.env.VITE_TIDE_URL ?? DEFAULT_URL,
    auth: { kind: "token", token: resolveDevToken() },
  });
  const store = createModelStore(conn);
  const detach = attachModelStore(store);

  conn.on("status", (status) => {
    if (status !== "open") return;
    conn
      .call("server.info", {})
      .then((info) => setEnvironmentId(info.environmentId))
      .catch(() => setEnvironmentId(null));
  });

  void conn.connect().catch(() => undefined);

  return () => {
    detach();
    store.dispose();
    conn.close();
  };
}
