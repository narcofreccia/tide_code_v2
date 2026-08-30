import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { newId } from "@tide/contracts";
import type { ServerConfig } from "../config.ts";
import type { Engine } from "../orchestration/engine.ts";
import type { EventStore } from "../orchestration/store.ts";
import { registerHandlers } from "./handlers.ts";
import { RpcRouter } from "./router.ts";
import { TicketIssuer } from "./tickets.ts";

const PING_INTERVAL_MS = 30_000;

export interface ServerDeps {
  engine: Engine;
  store: EventStore;
  config: ServerConfig;
}

export interface ServerHandle {
  port: number;
  host: string;
  url: string;
  close(): Promise<void>;
}

export async function startServer(deps: ServerDeps): Promise<ServerHandle> {
  const { config, engine, store } = deps;
  const startedAt = Date.now();
  const tickets = new TicketIssuer();

  const router = new RpcRouter();
  registerHandlers(router, {
    engine,
    store,
    environmentId: config.environmentId,
    version: config.version,
    startedAt,
  });

  const applyCors = (req: IncomingMessage, res: ServerResponse): void => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
  };
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  };

  const http: Server = createServer((req, res) => {
    applyCors(req, res);
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, environmentId: config.environmentId, version: config.version });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/auth/ws-ticket") {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${config.token}`) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      json(res, 200, tickets.issue("websocket"));
      return;
    }
    json(res, 404, { error: "not-found" });
  });

  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakMap<WebSocket, boolean>();

  const authorize = (url: URL): boolean => {
    const ticket = url.searchParams.get("wsTicket");
    if (ticket && tickets.consume(ticket)) return true;
    const token = url.searchParams.get("token");
    return config.dev && token !== null && token === config.token;
  };

  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const authorized = authorize(url);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!authorized) {
        // complete the handshake so the client sees a meaningful close code
        ws.close(4401, "unauthorized");
        return;
      }
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    alive.set(ws, true);
    const connection = router.connection(newId(), (frame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    });
    ws.on("pong", () => alive.set(ws, true));
    ws.on("message", (data) => {
      void connection.handleMessage(typeof data === "string" ? data : data.toString());
    });
    ws.on("close", () => connection.close());
    ws.on("error", () => connection.close());
  });

  const keepalive = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  keepalive.unref?.();

  await new Promise<void>((res, rej) => {
    http.once("error", rej);
    http.listen(config.port, config.host, () => {
      http.off("error", rej);
      res();
    });
  });

  const address = http.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;

  return {
    port,
    host: config.host,
    url: `ws://${config.host}:${port}/ws`,
    async close() {
      clearInterval(keepalive);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
    },
  };
}
