// Chrome DevTools Protocol plumbing for scripts/desktop-ui-smoke.mjs: debugging-port polling,
// target choice, a minimal CDP client and the in-page probe. Node >= 22 globals only.

export const CMD_TIMEOUT_MS = 5000;
export const HOSTS = ["127.0.0.1", "[::1]"]; // IPv4 and IPv6 loopback: "localhost" may resolve to either

export function errorText(e) {
  const c = e?.cause;
  return `${e?.name}: ${e?.message}${c ? ` (cause ${c.code ?? c.name}: ${c.message})` : ""}`;
}

/** Resolves { ok, json } or { ok: false, error } — the error text is evidence, not noise. */
export async function fetchJson(host, port, route) {
  try {
    const res = await fetch(`http://${host}:${port}${route}`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true, json: await res.json() };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function getJson(port, route, host = "127.0.0.1") {
  const r = await fetchJson(host, port, route);
  return r.ok ? r.json : null;
}

export async function portAnswers(port) {
  for (const host of HOSTS) if (await getJson(port, "/json/version", host)) return true;
  return false;
}

/** page first, then webview, other, then anything debuggable that is not DevTools itself. */
export function pickTarget(targets, allowFallback) {
  const usable = (Array.isArray(targets) ? targets : []).filter((t) => t.webSocketDebuggerUrl && !String(t.url).startsWith("devtools://"));
  const page = usable.find((t) => t.type === "page");
  if (page || !allowFallback) return page ? { target: page } : null;
  const alt = usable.find((t) => t.type === "webview") ?? usable.find((t) => t.type === "other") ?? usable[0];
  return alt ? { target: alt, fallback: `no page target; attached to type "${alt.type}" (${alt.url})` } : null;
}

/** Minimal CDP client: every command resolves (never rejects), with a per-command timeout. */
export class Cdp {
  static connect(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const fail = (why) => (clearTimeout(timer), ws.close(), reject(new Error(why)));
      const timer = setTimeout(() => fail("websocket connect timeout"), timeoutMs);
      ws.addEventListener("open", () => (clearTimeout(timer), resolve(new Cdp(ws))));
      ws.addEventListener("error", () => fail("websocket error"));
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = () => {};
    this.onClose = () => {};
    ws.addEventListener("message", (ev) => this.#receive(ev.data));
    ws.addEventListener("close", () => {
      for (const done of this.pending.values()) done({ ok: false, error: "socket closed" });
      this.pending.clear();
      this.onClose();
    });
  }

  #receive(data) {
    let msg = {};
    try { msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8")); } catch {}
    if (msg.id !== undefined) {
      const done = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      done?.(msg.error ? { ok: false, error: msg.error.message ?? JSON.stringify(msg.error) } : { ok: true, result: msg.result });
    } else if (msg.method) {
      this.onEvent(msg.method, msg.params ?? {});
    }
  }

  send(method, params = {}, timeoutMs = CMD_TIMEOUT_MS) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: "socket not open" });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, timedOut: true, error: `${method} timed out after ${timeoutMs} ms` });
      }, timeoutMs);
      this.pending.set(id, (r) => (clearTimeout(timer), resolve(r)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

export function isAppOrigin(url) {
  const u = URL.parse(url ?? "");
  return !!u && (u.hostname === "tauri.localhost" || u.protocol === "tauri:");
}

export function consoleText(args = []) {
  return args
    .map((a) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description ?? a.unserializableValue ?? a.type))
    .join(" ");
}

export const PAGE_PROBE = `(async () => {
  const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);
  const squash = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const root = document.getElementById("root");
  const out = {
    href: location.href,
    readyState: document.readyState,
    isSecureContext,
    rootChildren: root ? root.childElementCount : null,
    bodyText: squash(document.body && document.body.innerText).slice(0, 600),
    alerts: [...document.querySelectorAll("[role=alert]")].map((e) => squash(e.innerText || e.textContent)),
    dataset: { ...document.documentElement.dataset },
    userAgent: navigator.userAgent,
  };
  try {
    if ("serviceWorker" in navigator) {
      const regs = await within(navigator.serviceWorker.getRegistrations(), 3000);
      out.serviceWorker = {
        count: regs.length,
        controlled: navigator.serviceWorker.controller !== null,
        registrations: regs.map((r) => ({ scope: r.scope, activeScriptURL: r.active ? r.active.scriptURL : null,
          activeState: r.active ? r.active.state : null, installing: !!r.installing, waiting: !!r.waiting })),
      };
    } else out.serviceWorker = { unavailable: true };
  } catch (e) { out.serviceWorker = { error: String(e) }; }
  try { out.caches = typeof caches === "undefined" ? null : await within(caches.keys(), 3000); }
  catch (e) { out.caches = { error: String(e) }; }
  out.resources = performance.getEntriesByType("resource").slice(0, 40)
    .map((r) => ({ name: r.name, transferSize: r.transferSize, responseStatus: r.responseStatus }));
  return out;
})()`;
