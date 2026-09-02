import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { newId } from "@tide/contracts";
import type { ServerConfig } from "../config.ts";
import type { Engine } from "../orchestration/engine.ts";
import type { EventStore } from "../orchestration/store.ts";
import { DriverRegistry } from "../provider/registry.ts";
import { CheckpointService } from "../vcs/checkpoints.ts";
import type { GhLike } from "../vcs/gh.ts";
import { AgentTokenStore } from "./agentTickets.ts";
import { registerAgentHandlers } from "./agent.ts";
import { registerHandlers } from "./handlers.ts";
import { buildRemoteInfo, pairPage, type Interfaces } from "./remote.ts";
import { registerVcsHandlers } from "./vcs.ts";
import { createWorkspaceServices, registerWorkspaceHandlers, type WorkspaceServices } from "./workspace.ts";
import { RpcRouter } from "./router.ts";
import { TicketIssuer } from "./tickets.ts";

const PING_INTERVAL_MS = 30_000;

/** Host tools the UI may want to know about (Settings › Git); a cheap PATH scan at boot. */
function detectTools(): { git: boolean; gh: boolean; rg: boolean } {
  const has = (bin: string): boolean =>
    (process.env["PATH"] ?? "").split(delimiter).some((dir) => {
      try {
        accessSync(join(dir, bin), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  return { git: has("git"), gh: has("gh"), rg: has("rg") };
}

export interface ServerDeps {
  engine: Engine;
  store: EventStore;
  config: ServerConfig;
  /** omitted in tests that don't exercise providers: an empty registry is used */
  registry?: DriverRegistry;
  /** omitted in tests that don't exercise git: a stand-alone service is used */
  checkpoints?: CheckpointService;
  /** tests inject a fake GitHub CLI; shared with the vcs reactor by the app */
  gh?: GhLike;
  /** files/watcher/search/terminals; the app builds these once and owns their lifetime */
  workspace?: WorkspaceServices;
  /** per-thread agent tokens; the app shares this with the MCP provisioner */
  agentTokens?: AgentTokenStore;
  /** tests mock the host's network interfaces to assert the LAN URL shape */
  networkInterfaces?: () => Interfaces;
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
  const agentTokens = deps.agentTokens ?? new AgentTokenStore();

  const registry =
    deps.registry ?? new DriverRegistry({ env: { dataDir: config.dataDir, log: (msg, data) => (data === undefined ? console.error(msg) : console.error(msg, data)) } });

  // the real port is only known after listen(); every remote lookup reads it late
  let boundPort = config.port;
  const remote = ({ includePairing }: { includePairing: boolean }) =>
    buildRemoteInfo({
      host: config.host,
      port: boundPort,
      token: config.token,
      includePairing,
      ...(deps.networkInterfaces !== undefined ? { interfaces: deps.networkInterfaces() } : {}),
    });

  const router = new RpcRouter();
  registerHandlers(router, {
    engine,
    store,
    registry,
    environmentId: config.environmentId,
    version: config.version,
    startedAt,
    tideHome: config.tideHome,
    tools: detectTools(),
    remote,
  });
  registerAgentHandlers(router, { engine });
  registerVcsHandlers(router, {
    engine,
    checkpoints: deps.checkpoints ?? new CheckpointService(),
    ...(deps.gh !== undefined ? { gh: deps.gh } : {}),
  });
  const workspace = deps.workspace ?? createWorkspaceServices({ engine });
  const ownsWorkspace = deps.workspace === undefined;
  registerWorkspaceHandlers(router, workspace);

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
    if (req.method === "GET" && url.pathname === "/pair") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pairPage(remote({ includePairing: false })));
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

  /** null = rejected; otherwise the connection's privileges. */
  const authorize = (url: URL): { agentThreadId?: string } | null => {
    const agentToken = url.searchParams.get("agentToken");
    if (agentToken !== null) {
      const agentThreadId = agentTokens.resolve(agentToken);
      return agentThreadId === undefined ? null : { agentThreadId };
    }
    const ticket = url.searchParams.get("wsTicket");
    if (ticket && tickets.consume(ticket)) return {};
    const token = url.searchParams.get("token");
    return config.dev && token !== null && token === config.token ? {} : null;
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
      wss.emit("connection", ws, req, authorized);
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, privileges: { agentThreadId?: string } = {}) => {
    alive.set(ws, true);
    const connection = router.connection(
      newId(),
      (frame) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
      },
      privileges,
    );
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
  boundPort = port;

  return {
    port,
    host: config.host,
    url: `ws://${config.host}:${port}/ws`,
    async close() {
      clearInterval(keepalive);
      if (ownsWorkspace) workspace.close();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
    },
  };
}
