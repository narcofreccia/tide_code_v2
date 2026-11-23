// The minimum of Tide's WebSocket RPC that scripts/server-rpc-probe.mjs needs, written by hand
// (packages/contracts/src/rpc.ts: request {id, method, params}; a response frame carries the same
// id and exactly one of result / error / chunk / end). Auth as packages/client does it: buy a
// single-use ticket with `POST /api/auth/ws-ticket` + `Authorization: Bearer <token>` and open
// `/ws?wsTicket=…`, or, on a `--dev` server, put the token itself on the socket (`/ws?token=…`).
// Every call resolves (never throws) with { status: ok | error | timeout | closed, ms, … }.

/** The desktop page's origin; the server does not check Origin on token-bearing requests, but a real client sends one. */
export const DESKTOP_ORIGIN = "http://tauri.localhost";

const now = () => Date.now();

/** ws://127.0.0.1:3777/ws -> http://127.0.0.1:3777 */
export function httpBaseOf(wsUrl) {
  const u = new URL(wsUrl);
  return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
}

/** fetch with a deadline; resolves { ok, status, json | text, ms } or { ok: false, error, ms }. */
export async function fetchWithTimeout(url, init, timeoutMs) {
  const t0 = now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: res.ok, status: res.status, ...(json !== undefined ? { json } : { text: text.slice(0, 500) }), ms: now() - t0 };
  } catch (e) {
    return { ok: false, error: e?.name === "TimeoutError" ? `no answer within ${timeoutMs} ms` : String(e?.message ?? e), ms: now() - t0 };
  }
}

/** GET /health: answered = the server's event loop is turning (independent of the RPC socket). */
export async function health(httpBase, timeoutMs = 3000) {
  const r = await fetchWithTimeout(`${httpBase}/health`, { headers: { Origin: DESKTOP_ORIGIN } }, timeoutMs);
  return { answered: r.status !== undefined, status: r.status ?? null, ms: r.ms, ...(r.error ? { error: r.error } : {}) };
}

/** A ticket for one socket. Resolves { ok, ticket } or { ok: false, error }. */
export async function buyTicket(httpBase, token, timeoutMs = 10_000) {
  const r = await fetchWithTimeout(
    `${httpBase}/api/auth/ws-ticket`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: DESKTOP_ORIGIN } },
    timeoutMs,
  );
  if (r.ok && typeof r.json?.ticket === "string") return { ok: true, ticket: r.json.ticket, ms: r.ms };
  return { ok: false, error: r.error ?? `HTTP ${r.status}: ${JSON.stringify(r.json ?? r.text)}`, ms: r.ms };
}

export class RpcSocket {
  #ws = null;
  #pending = new Map();
  #seq = 0;

  constructor() {
    this.closeInfo = null; // { code, reason, t }
    this.openedAt = null;
    this.strayFrames = 0;
  }

  /** Opens the socket; resolves { ok, ms, auth } or { ok: false, error }. `secrets` collects what must be redacted. */
  static async open({ wsUrl, token, auth, secrets, timeoutMs = 15_000 }) {
    const sock = new RpcSocket();
    const t0 = now();
    const url = new URL(wsUrl);
    if (auth === "ticket") {
      const t = await buyTicket(httpBaseOf(wsUrl), token);
      if (!t.ok) return { ok: false, error: `ws-ticket: ${t.error}`, ms: now() - t0, auth };
      secrets.add(t.ticket);
      url.searchParams.set("wsTicket", t.ticket);
    } else {
      url.searchParams.set("token", token);
    }
    const opened = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      let ws;
      try {
        // Node's WebSocket (undici) takes extra handshake headers; a browser would send its page origin
        ws = new WebSocket(url.toString(), { headers: { Origin: DESKTOP_ORIGIN } });
      } catch (e) {
        return done({ ok: false, error: String(e?.message ?? e) });
      }
      sock.#ws = ws;
      const timer = setTimeout(() => { done({ ok: false, error: `socket not open within ${timeoutMs} ms` }); try { ws.close(); } catch { /* closing */ } }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); sock.openedAt = now(); done({ ok: true }); };
      ws.onerror = (ev) => { clearTimeout(timer); done({ ok: false, error: `socket error: ${ev?.message ?? ev?.error?.message ?? "unknown"}` }); };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        sock.closeInfo = { code: ev.code, reason: ev.reason, t: now() };
        done({ ok: false, error: `socket closed during open (code ${ev.code} ${ev.reason || ""})`.trim() });
        for (const [, p] of sock.#pending) p.finish({ status: "closed", error: { code: "socket-closed", message: `closed with code ${ev.code} ${ev.reason || ""}`.trim() } });
        sock.#pending.clear();
      };
      ws.onmessage = (ev) => sock.#onFrame(typeof ev.data === "string" ? ev.data : String(ev.data));
    });
    // the server closes an unauthorized socket right after the handshake with 4401: wait a beat to see it
    if (opened.ok) await new Promise((r) => setTimeout(r, 300));
    if (opened.ok && sock.closeInfo) return { ok: false, error: `socket closed right after open (code ${sock.closeInfo.code} ${sock.closeInfo.reason})`, ms: now() - t0, auth };
    return opened.ok ? { ok: true, socket: sock, ms: now() - t0, auth } : { ok: false, error: opened.error, ms: now() - t0, auth };
  }

  get isOpen() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  get readyState() {
    return ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][this.#ws?.readyState ?? 3];
  }

  #onFrame(data) {
    let frame;
    try { frame = JSON.parse(data); } catch { this.strayFrames++; return; }
    const p = this.#pending.get(frame?.id);
    if (!p) { this.strayFrames++; return; }
    if ("result" in frame) p.finish({ status: "ok", result: frame.result });
    else if ("error" in frame) p.finish({ status: "error", error: frame.error });
    else p.finish({ status: "error", error: { code: "unexpected-frame", message: `a unary call got ${Object.keys(frame).join(",")}` } });
  }

  /** One unary call. A timed-out call stays registered so a late answer is still recorded in `lateAnswers`. */
  call(method, params, timeoutMs, lateAnswers = []) {
    const id = `probe-${++this.#seq}`;
    const t0 = now();
    const startedAt = new Date(t0).toISOString();
    return new Promise((resolve) => {
      let timedOut = false;
      const finish = (r) => {
        this.#pending.delete(id);
        clearTimeout(timer);
        if (timedOut) { lateAnswers.push({ id, method, afterMs: now() - t0, ...r }); return; }
        resolve({ method, id, startedAt, ms: now() - t0, ...r });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        resolve({ method, id, startedAt, ms: now() - t0, status: "timeout", timeoutMs, socketOpenAtTimeout: this.isOpen });
      }, timeoutMs);
      this.#pending.set(id, { finish });
      if (!this.isOpen) return finish({ status: "closed", error: { code: "socket-closed", message: `socket is ${this.readyState}` } });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        finish({ status: "error", error: { code: "send-failed", message: String(e?.message ?? e) } });
      }
    });
  }

  close() {
    try { this.#ws?.close(); } catch { /* already closed */ }
  }
}
