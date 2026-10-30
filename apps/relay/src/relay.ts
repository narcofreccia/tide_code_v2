import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { HookStore } from "./hooks.ts";
import { cleanHeaders, decodeData, encodeData, parseControl, sendableCode, toBuffer, type DownControl, type Headers, type UpControl } from "./protocol.ts";

export const LIMITS = {
  /** http request/response bodies tunnelled through /c/<env>/… */
  httpBody: 8 * 1024 * 1024,
  hookBody: 256 * 1024,
  /** a single WS frame on the tunnel; the uplink adds base64 + framing overhead on top */
  frame: 16 * 1024 * 1024,
  uplinkFrame: 24 * 1024 * 1024,
  /** a channel is closed when the uplink cannot drain this much (slow environment) */
  uplinkBuffer: 32 * 1024 * 1024,
};

export interface RelayOptions {
  /** shared secret every environment presents on /env/connect */
  key: string;
  /** SQLite file for held webhooks; ":memory:" (default) loses them on restart */
  dbPath?: string;
  now?: () => number;
  /** keepalive sweep period (ping both ways, drop peers that missed a pong) */
  pingMs?: number;
  /** a tunnel channel with no data either way for this long is closed */
  idleMs?: number;
  /** how long a forwarded http request waits for the environment */
  requestTimeoutMs?: number;
  maxChannels?: number;
  /** false: no interval; tests call sweep() */
  autoSweep?: boolean;
  log?: (msg: string) => void;
}

export interface Relay {
  server: Server;
  hooks: HookStore;
  listen(port: number, host?: string): Promise<number>;
  /** one keepalive/idle pass (runs every pingMs unless autoSweep is false) */
  sweep(): void;
  environments(): number;
  close(): Promise<void>;
}

interface Channel {
  ws: WebSocket;
  lastActive: number;
  alive: boolean;
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: Buffer;
}

interface Uplink {
  envId: string;
  ws: WebSocket;
  alive: boolean;
  channels: Map<number, Channel>;
  nextChannel: number;
  pending: Map<number, (r: HttpResult | undefined) => void>;
  nextRequest: number;
  replaying: boolean;
}

const CORS: Headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
  "access-control-max-age": "600",
};

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

export function createRelay(options: RelayOptions): Relay {
  if (options.key.length === 0) throw new Error("relay key must not be empty");
  const keyDigest = digest(options.key);
  const now = options.now ?? Date.now;
  const log = options.log ?? ((msg: string) => console.error(msg));
  const idleMs = options.idleMs ?? 60 * 60 * 1000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const maxChannels = options.maxChannels ?? 64;
  const hooks = new HookStore(options.dbPath ?? ":memory:", now);
  const uplinks = new Map<string, Uplink>();
  const uplinkWss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.uplinkFrame });
  const tunnelWss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.frame });

  const send = (res: ServerResponse, status: number, body: string | Buffer, headers: Headers = {}): void => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body);
  };

  const forward = (up: Uplink, method: string, path: string, headers: Headers, body: Buffer): Promise<HttpResult | undefined> =>
    new Promise((resolve) => {
      if (up.ws.readyState !== WebSocket.OPEN) return resolve(undefined);
      const id = up.nextRequest++;
      const timer = setTimeout(() => settle(undefined), requestTimeoutMs);
      const settle = (r: HttpResult | undefined): void => {
        clearTimeout(timer);
        up.pending.delete(id);
        resolve(r);
      };
      up.pending.set(id, settle);
      const frame: DownControl = { t: "http", id, method, path, headers, ...(body.length > 0 ? { body: body.toString("base64") } : {}) };
      up.ws.send(JSON.stringify(frame));
    });

  const replay = async (up: Uplink): Promise<void> => {
    if (up.replaying) return;
    up.replaying = true;
    try {
      while (uplinks.get(up.envId) === up) {
        const hook = hooks.next(up.envId);
        if (hook === undefined) break;
        const r = await forward(up, "POST", `/hook/${encodeURIComponent(hook.hookId)}`, hook.headers, hook.body);
        if (r === undefined) break; // offline again: keep it for the next uplink
        if (r.status >= 500) log(`[relay] env ${up.envId} rejected held hook ${hook.hookId} (${r.status}); dropped`);
        hooks.remove(hook.seq);
      }
    } finally {
      up.replaying = false;
    }
  };

  const handleHook = async (req: IncomingMessage, res: ServerResponse, envId: string, hookId: string): Promise<void> => {
    const body = await readBody(req, LIMITS.hookBody);
    if (body === undefined) return send(res, 413, JSON.stringify({ error: "too-large" }), { connection: "close" });
    const delivery = header(req, "x-tide-delivery");
    if (delivery !== undefined && hooks.seen(envId, delivery)) return send(res, 200, JSON.stringify({ ok: true, duplicate: true }));
    const headers = cleanHeaders(req.headers);
    headers["x-tide-relay"] = "1";
    const up = uplinks.get(envId);
    if (up !== undefined && !up.replaying && hooks.pending(envId) === 0) {
      const r = await forward(up, "POST", `/hook/${encodeURIComponent(hookId)}`, headers, body);
      if (r !== undefined) {
        // the sender retries a 5xx itself; that retry must not be swallowed as a duplicate
        if (r.status >= 500 && delivery !== undefined) hooks.unsee(envId, delivery);
        return send(res, r.status, r.body, cleanHeaders(r.headers, ["content-encoding"]));
      }
    }
    hooks.put({ id: delivery ?? randomUUID(), envId, hookId, headers, body, receivedAt: now() });
    send(res, 202, JSON.stringify({ ok: true, queued: true }));
    const live = uplinks.get(envId);
    if (live !== undefined) void replay(live);
  };

  const handleTunnelHttp = async (req: IncomingMessage, res: ServerResponse, envId: string, path: string): Promise<void> => {
    if (req.method === "OPTIONS") return send(res, 204, "", CORS);
    const up = uplinks.get(envId);
    if (path === "/_relay/info" && req.method === "GET") return send(res, 200, JSON.stringify({ online: up !== undefined }), CORS);
    if (up === undefined) return send(res, 503, JSON.stringify({ error: "offline" }), CORS);
    const body = await readBody(req, LIMITS.httpBody);
    if (body === undefined) return send(res, 413, JSON.stringify({ error: "too-large" }), { ...CORS, connection: "close" });
    const headers = cleanHeaders(req.headers);
    headers["x-tide-relay"] = "1";
    const r = await forward(up, req.method ?? "GET", path, headers, body);
    if (r === undefined) return send(res, 504, JSON.stringify({ error: "environment-timeout" }), CORS);
    const out = cleanHeaders(r.headers, ["content-encoding"]);
    for (const k of Object.keys(out)) if (k.startsWith("access-control-")) delete out[k];
    res.writeHead(r.status, { ...out, ...CORS });
    res.end(r.body);
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, JSON.stringify({ ok: true, environments: uplinks.size }));
    const tunnel = /^\/c\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (tunnel !== null) return handleTunnelHttp(req, res, decode(tunnel[1]), (tunnel[2] ?? "/") + url.search);
    const hook = /^\/hook\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (hook !== null && req.method === "POST") return handleHook(req, res, decode(hook[1]), decode(hook[2]));
    send(res, 404, JSON.stringify({ error: "not-found" }));
  };

  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      log(`[relay] request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) send(res, 500, JSON.stringify({ error: "internal" }));
      else res.destroy();
    });
  });

  const dropUplink = (up: Uplink, reason: string): void => {
    if (uplinks.get(up.envId) === up) uplinks.delete(up.envId);
    for (const ch of up.channels.values()) ch.ws.close(1012, reason);
    up.channels.clear();
    for (const settle of [...up.pending.values()]) settle(undefined);
  };

  const attachUplink = (envId: string, ws: WebSocket): void => {
    const old = uplinks.get(envId);
    if (old !== undefined) {
      dropUplink(old, "environment reconnected");
      old.ws.close(4409, "superseded");
    }
    const up: Uplink = { envId, ws, alive: true, channels: new Map(), nextChannel: 1, pending: new Map(), nextRequest: 1, replaying: false };
    uplinks.set(envId, up);
    log(`[relay] env ${envId} connected (${uplinks.size} online)`);
    ws.on("pong", () => (up.alive = true));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const frame = decodeData(toBuffer(data));
        const ch = frame === undefined ? undefined : up.channels.get(frame.channel);
        if (frame === undefined || ch === undefined) return;
        ch.lastActive = now();
        if (ch.ws.readyState === WebSocket.OPEN) ch.ws.send(frame.payload, { binary: frame.binary });
        return;
      }
      const msg = parseControl<UpControl>(toBuffer(data).toString("utf8"));
      if (msg?.t === "close") {
        const ch = up.channels.get(msg.c);
        up.channels.delete(msg.c);
        ch?.ws.close(sendableCode(msg.code), msg.reason ?? "");
      } else if (msg?.t === "res") {
        up.pending.get(msg.id)?.({ status: msg.status, headers: msg.headers ?? {}, body: Buffer.from(msg.body ?? "", "base64") });
      }
    });
    ws.on("close", () => {
      if (uplinks.get(envId) === up) log(`[relay] env ${envId} disconnected`);
      dropUplink(up, "environment offline");
    });
    ws.on("error", () => ws.terminate());
    void replay(up);
  };

  const attachChannel = (up: Uplink, ws: WebSocket, path: string): void => {
    const c = up.nextChannel++;
    const ch: Channel = { ws, lastActive: now(), alive: true };
    up.channels.set(c, ch);
    up.ws.send(JSON.stringify({ t: "open", c, path } satisfies DownControl));
    ws.on("pong", () => (ch.alive = true));
    ws.on("message", (data, isBinary) => {
      if (up.ws.readyState !== WebSocket.OPEN) return;
      if (up.ws.bufferedAmount > LIMITS.uplinkBuffer) return ws.close(1013, "environment backlog");
      ch.lastActive = now();
      up.ws.send(encodeData(c, toBuffer(data), isBinary));
    });
    ws.on("close", (code, reason) => {
      if (up.channels.get(c) !== ch) return;
      up.channels.delete(c);
      if (up.ws.readyState === WebSocket.OPEN) up.ws.send(JSON.stringify({ t: "close", c, code, reason: reason.toString() } satisfies DownControl));
    });
    ws.on("error", () => ws.terminate());
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (url.pathname === "/env/connect") {
      const envId = url.searchParams.get("env") ?? "";
      if (!timingSafeEqual(digest(url.searchParams.get("key") ?? ""), keyDigest)) return reject(socket, 401);
      if (envId.length === 0 || envId.length > 200) return reject(socket, 400);
      uplinkWss.handleUpgrade(req, socket, head, (ws) => attachUplink(envId, ws));
      return;
    }
    const m = /^\/c\/([^/]+)\/ws$/.exec(url.pathname);
    if (m === null) return reject(socket, 404);
    const up = uplinks.get(decode(m[1]));
    if (up === undefined) return reject(socket, 503);
    if (up.channels.size >= maxChannels) return reject(socket, 429);
    tunnelWss.handleUpgrade(req, socket, head, (ws) => attachChannel(up, ws, `/ws${url.search}`));
  });

  const sweep = (): void => {
    const t = now();
    for (const up of uplinks.values()) {
      if (!up.alive) {
        up.ws.terminate();
        continue;
      }
      up.alive = false;
      up.ws.ping();
      for (const ch of up.channels.values()) {
        if (!ch.alive) ch.ws.terminate();
        else if (t - ch.lastActive > idleMs) ch.ws.close(1001, "idle");
        else {
          ch.alive = false;
          ch.ws.ping();
        }
      }
    }
    hooks.prune();
  };
  const interval = options.autoSweep === false ? undefined : setInterval(sweep, options.pingMs ?? 20_000);
  interval?.unref();

  return {
    server,
    hooks,
    sweep,
    environments: () => uplinks.size,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
      }),
    async close() {
      if (interval !== undefined) clearInterval(interval);
      for (const up of [...uplinks.values()]) {
        dropUplink(up, "relay shutting down");
        up.ws.terminate();
      }
      for (const ws of tunnelWss.clients) ws.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      hooks.close();
    },
  };
}

function decode(s: string | undefined): string {
  try {
    return decodeURIComponent(s ?? "");
  } catch {
    return s ?? "";
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function reject(socket: Duplex, status: number): void {
  const body = JSON.stringify({ error: STATUS_CODES[status] ?? "error" });
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

/** Reads a request body, or undefined once it exceeds `limit` (the rest is drained and discarded). */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) over = true;
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? undefined : Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}
