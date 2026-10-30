import { WebSocket } from "ws";

/**
 * R9: the environment side of the self-hosted relay (apps/relay, docs/internals/relay.md).
 * Holds one outbound "uplink" WebSocket to the relay and replays what arrives on it against
 * this server's own loopback port: tunnel channels become loopback `/ws` sockets (the server
 * still authenticates them by ticket/token), `http` frames become loopback fetches (webhooks hit
 * `/hook/<id>`, so the server's own handler runs). The wire format is duplicated from
 * apps/relay/src/protocol.ts on purpose: the sidecar must not depend on the relay package.
 */

export interface RelayConfig {
  url: string;
  key?: string;
}

export interface RelayState {
  url: string;
  connected: boolean;
  /** http(s) origin clients use instead of this server: `<relay>/c/<environmentId>` */
  clientUrl: string;
}

export interface RelayClientOptions {
  environmentId: string;
  /** the loopback port of this server's HTTP/WS listener */
  port: number;
  host?: string;
  log?: (msg: string, data?: unknown) => void;
  /** reconnect timer; tests pass a manual one */
  schedule?: (fn: () => void, ms: number) => () => void;
  pingMs?: number;
  fetch?: typeof fetch;
}

export interface RelayClient {
  state(): RelayState | undefined;
  /** (re)connects with this config; undefined disconnects and forgets the relay */
  restart(cfg: RelayConfig | undefined): void;
  stop(): void;
}

const MAX_BODY = 8 * 1024 * 1024;
const MAX_FRAME = 24 * 1024 * 1024;
const BACKOFF_MIN = 1_000;
const BACKOFF_MAX = 60_000;
const DROP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "content-encoding", "te", "trailer"]);

type Down =
  | { t: "open"; c: number; path: string }
  | { t: "close"; c: number; code?: number; reason?: string }
  | { t: "http"; id: number; method: string; path: string; headers: Record<string, string>; body?: string };

interface Channel {
  ws: WebSocket;
  queue: { payload: Buffer; binary: boolean }[];
}

/** `wss://r.example/` or `https://r.example` -> both forms without a trailing slash. */
export function relayUrls(url: string, environmentId: string, key?: string): { uplink: string; clientUrl: string } {
  const base = url.trim().replace(/\/+$/, "");
  const http = base.replace(/^ws(s?):\/\//i, "http$1://");
  const ws = http.replace(/^http(s?):\/\//i, "ws$1://");
  const query = new URLSearchParams({ env: environmentId, ...(key !== undefined ? { key } : {}) });
  return { uplink: `${ws}/env/connect?${query.toString()}`, clientUrl: `${http}/c/${encodeURIComponent(environmentId)}` };
}

export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MIN * 2 ** attempt, BACKOFF_MAX);
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const host = options.host ?? "127.0.0.1";
  const log = options.log ?? (() => undefined);
  const doFetch = options.fetch ?? fetch;
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    });

  let cfg: RelayConfig | undefined;
  let generation = 0;
  let uplink: WebSocket | undefined;
  let connected = false;
  let alive = true;
  let attempt = 0;
  let cancelRetry: (() => void) | undefined;
  const channels = new Map<number, Channel>();

  const closeChannels = (): void => {
    for (const ch of channels.values()) ch.ws.readyState === WebSocket.CONNECTING ? ch.ws.terminate() : ch.ws.close(1001, "relay gone");
    channels.clear();
  };

  const sendUp = (ws: WebSocket, data: string | Buffer): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  const openChannel = (ws: WebSocket, c: number, path: string): void => {
    if (!path.startsWith("/ws")) return sendUp(ws, JSON.stringify({ t: "close", c, code: 4404, reason: "not-found" }));
    const loop = new WebSocket(`ws://${host}:${options.port}${path}`, { headers: { "x-tide-relay": "1" }, maxPayload: MAX_FRAME });
    const ch: Channel = { ws: loop, queue: [] };
    channels.set(c, ch);
    loop.on("open", () => {
      for (const f of ch.queue) loop.send(f.payload, { binary: f.binary });
      ch.queue = [];
    });
    loop.on("message", (data, isBinary) => sendUp(ws, encodeData(c, toBuffer(data), isBinary)));
    loop.on("close", (code, reason) => {
      if (channels.get(c) !== ch) return;
      channels.delete(c);
      sendUp(ws, JSON.stringify({ t: "close", c, code, reason: reason.toString() }));
    });
    loop.on("error", () => loop.terminate());
  };

  const handleHttp = async (ws: WebSocket, msg: Extract<Down, { t: "http" }>): Promise<void> => {
    const reply = (status: number, headers: Record<string, string>, body?: Buffer): void =>
      sendUp(ws, JSON.stringify({ t: "res", id: msg.id, status, headers, ...(body !== undefined && body.length > 0 ? { body: body.toString("base64") } : {}) }));
    if (!msg.path.startsWith("/") || msg.path.startsWith("//")) return reply(400, { "content-type": "application/json" }, Buffer.from('{"error":"bad-path"}'));
    try {
      const method = msg.method.toUpperCase();
      const res = await doFetch(`http://${host}:${options.port}${msg.path}`, {
        method,
        headers: { ...msg.headers, "x-tide-relay": "1" },
        redirect: "manual",
        ...(method !== "GET" && method !== "HEAD" && msg.body !== undefined ? { body: Buffer.from(msg.body, "base64") } : {}),
      });
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_BODY) return reply(502, { "content-type": "application/json" }, Buffer.from('{"error":"response-too-large"}'));
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (!DROP.has(k)) headers[k] = v;
      });
      reply(res.status, headers, body);
    } catch (err) {
      log("[relay] loopback request failed", err instanceof Error ? err.message : String(err));
      reply(502, { "content-type": "application/json" }, Buffer.from('{"error":"loopback-failed"}'));
    }
  };

  const onMessage = (ws: WebSocket, data: unknown, isBinary: boolean): void => {
    const buf = toBuffer(data);
    if (isBinary) {
      if (buf.length < 5) return;
      const ch = channels.get(buf.readUInt32BE(0));
      if (ch === undefined) return;
      const f = { payload: buf.subarray(5), binary: buf.readUInt8(4) === 1 };
      if (ch.ws.readyState === WebSocket.OPEN) ch.ws.send(f.payload, { binary: f.binary });
      else if (ch.ws.readyState === WebSocket.CONNECTING) ch.queue.push(f);
      return;
    }
    let msg: Down;
    try {
      msg = JSON.parse(buf.toString("utf8")) as Down;
    } catch {
      return;
    }
    if (msg.t === "open") openChannel(ws, msg.c, msg.path);
    else if (msg.t === "close") {
      const ch = channels.get(msg.c);
      channels.delete(msg.c);
      if (ch === undefined) return;
      if (ch.ws.readyState === WebSocket.CONNECTING) ch.ws.terminate();
      else ch.ws.close(sendableCode(msg.code), msg.reason ?? "");
    } else if (msg.t === "http") void handleHttp(ws, msg);
  };

  const connect = (): void => {
    if (cfg === undefined) return;
    const gen = generation;
    const { uplink: target } = relayUrls(cfg.url, options.environmentId, cfg.key);
    let ws: WebSocket;
    try {
      ws = new WebSocket(target, { maxPayload: MAX_FRAME });
    } catch (err) {
      log("[relay] bad relay url", err instanceof Error ? err.message : String(err));
      return;
    }
    uplink = ws;
    alive = true;
    ws.on("open", () => {
      if (gen !== generation) return ws.terminate();
      connected = true;
      attempt = 0;
      log(`[relay] connected to ${cfg?.url ?? ""}`);
    });
    ws.on("pong", () => (alive = true));
    ws.on("message", (data, isBinary) => gen === generation && onMessage(ws, data, isBinary));
    ws.on("unexpected-response", (_req, res) => {
      log(`[relay] relay refused the uplink (${res.statusCode ?? "?"})`);
      ws.terminate();
    });
    ws.on("error", () => undefined); // the close that follows schedules the retry
    ws.on("close", (code) => {
      if (gen !== generation) return;
      if (connected) log(`[relay] disconnected (${code})`);
      connected = false;
      uplink = undefined;
      closeChannels();
      const delay = backoffMs(attempt++);
      cancelRetry = schedule(() => {
        cancelRetry = undefined;
        if (gen === generation) connect();
      }, delay);
    });
  };

  const keepalive = setInterval(() => {
    const ws = uplink;
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) return;
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, options.pingMs ?? 20_000);
  keepalive.unref();

  const teardown = (): void => {
    generation++;
    cancelRetry?.();
    cancelRetry = undefined;
    closeChannels();
    uplink?.terminate();
    uplink = undefined;
    connected = false;
    attempt = 0;
  };

  return {
    state: () => (cfg === undefined ? undefined : { url: cfg.url, connected, clientUrl: relayUrls(cfg.url, options.environmentId).clientUrl }),
    restart(next) {
      teardown();
      cfg = next === undefined || next.url.trim().length === 0 ? undefined : { ...next };
      connect();
    },
    stop() {
      teardown();
      cfg = undefined;
      clearInterval(keepalive);
    },
  };
}

/** The slice of SettingsStore the client follows (structural, so the relay e2e test can import this file alone). */
export interface RelaySettings {
  relayConfig(): RelayConfig | undefined;
  set(patch: { relay?: unknown }): unknown;
}

/**
 * Starts the client from `settings.relayConfig()` and follows every `settings.set` that touches
 * `relay` (the store has no change feed, so `set` is wrapped once here).
 */
export function startRelayClient(settings: RelaySettings, options: RelayClientOptions): RelayClient {
  const client = createRelayClient(options);
  client.restart(settings.relayConfig());
  const set = settings.set.bind(settings);
  settings.set = (patch: { relay?: unknown }) => {
    const next = set(patch);
    if (patch.relay !== undefined) client.restart(settings.relayConfig());
    return next;
  };
  return client;
}

function encodeData(channel: number, payload: Buffer, binary: boolean): Buffer {
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(channel >>> 0, 0);
  head.writeUInt8(binary ? 1 : 0, 4);
  return Buffer.concat([head, payload]);
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
}

function sendableCode(code: number | undefined): number {
  if (code === undefined || code === 1005) return 1000;
  if (code === 1000 || code === 1001 || code === 1003 || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return 1011;
}
