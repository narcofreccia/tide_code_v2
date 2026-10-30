import type { IncomingMessage, ServerResponse } from "node:http";
import type { EnvProbe, PairResponse } from "@tide/contracts";
import type { ServerConfig } from "../config.ts";
import { handleWebhook, WEBHOOK_MAX_BODY, type WebhookDeps } from "../scheduling/webhooks.ts";
import { PROTOCOL_VERSION } from "../version.ts";
import { safeEqual, type PairingCodes } from "./pairing.ts";
import { landingPage, pairPage, type RemoteInfo } from "./remote.ts";
import { serveStatic } from "./static.ts";
import type { TicketIssuer } from "./tickets.ts";

export interface HttpContext {
  config: ServerConfig;
  tickets: TicketIssuer;
  pairing: PairingCodes;
  remote: (options: { includePairing: boolean }) => RemoteInfo;
  /** settings.environment.name, read per request (the user may rename the machine) */
  envName: () => string;
  webhook: WebhookDeps;
}

/**
 * `configured`: only the origins in config.corsOrigins (the dev web server, TIDE_CORS_ORIGINS).
 * `any`: `*` — the route is either public (`/api/env`) or guarded by something other than the
 * origin (the bearer token, a single-use pairing code), so a browser on any origin may call it.
 */
type Cors = "configured" | "any" | "none";

interface Route {
  method: "GET" | "POST";
  /** exact path, or a prefix ending in "/" whose remainder becomes `param` */
  path: string;
  cors: Cors;
  handle(req: IncomingMessage, res: ServerResponse, param: string): void | Promise<void>;
}

const PAIR_BODY_MAX = 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  res.end(body);
}

/** Reads the request body, or "too-large" (the rest is drained, never buffered). */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) over = true;
      if (!over) chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? "too-large" : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function applyCors(cors: Cors, req: IncomingMessage, res: ServerResponse, allowed: string[]): void {
  const origin = req.headers.origin;
  if (cors === "any") res.setHeader("Access-Control-Allow-Origin", "*");
  else if (cors === "configured" && origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else return;
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
}

function routes(ctx: HttpContext): Route[] {
  const { config } = ctx;
  return [
    {
      method: "GET",
      path: "/health",
      cors: "configured",
      handle: (_req, res) => json(res, 200, { ok: true, environmentId: config.environmentId, version: config.version }),
    },
    {
      method: "GET",
      path: "/api/env",
      cors: "any",
      handle: (_req, res) => {
        const probe: EnvProbe = { environmentId: config.environmentId, name: ctx.envName(), version: config.version, protocol: PROTOCOL_VERSION };
        json(res, 200, probe);
      },
    },
    {
      method: "GET",
      path: "/pair",
      cors: "none",
      handle: (_req, res) => html(res, pairPage(ctx.remote({ includePairing: false }))),
    },
    {
      method: "POST",
      path: "/api/auth/ws-ticket",
      cors: "any",
      handle: (req, res) => {
        const auth = req.headers.authorization ?? "";
        if (!safeEqual(auth, `Bearer ${config.token}`)) return json(res, 401, { error: "unauthorized" });
        json(res, 200, ctx.tickets.issue("websocket"));
      },
    },
    {
      method: "POST",
      path: "/api/auth/pair",
      cors: "any",
      handle: async (req, res) => {
        const raw = await readBody(req, PAIR_BODY_MAX);
        if (raw === "too-large") return json(res, 413, { error: "payload-too-large" });
        let code: unknown;
        try {
          code = (JSON.parse(raw.toString("utf8")) as { code?: unknown }).code;
        } catch {
          return json(res, 400, { error: "invalid-params", message: "body must be JSON {code}" });
        }
        if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) return json(res, 400, { error: "invalid-params", message: "code must be 6 digits" });
        const outcome = ctx.pairing.exchange(code.trim(), req.socket.remoteAddress ?? "unknown");
        if (outcome === "rate-limited") {
          res.setHeader("Retry-After", "60");
          return json(res, 429, { error: "rate-limited" });
        }
        if (outcome === "invalid") return json(res, 401, { error: "invalid-code" });
        const body: PairResponse = { environmentId: config.environmentId, name: ctx.envName(), token: config.token };
        json(res, 200, body);
      },
    },
    {
      method: "POST",
      path: "/hook/",
      cors: "none",
      handle: async (req, res, hookId) => {
        const raw = await readBody(req, WEBHOOK_MAX_BODY);
        if (raw === "too-large") return json(res, 413, { error: "payload-too-large" });
        const result = await handleWebhook(ctx.webhook, hookId, raw, req.headers);
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(result.body);
      },
    },
  ];
}

function match(route: Route, pathname: string): string | undefined {
  if (route.path.endsWith("/")) {
    if (!pathname.startsWith(route.path)) return undefined;
    const rest = pathname.slice(route.path.length);
    if (rest.length === 0 || rest.includes("/")) return undefined;
    try {
      return decodeURIComponent(rest);
    } catch {
      return undefined;
    }
  }
  return pathname === route.path ? "" : undefined;
}

/** The HTTP side of tide-server: a small route table, then static web assets, then 404. */
export function createHttpHandler(ctx: HttpContext): (req: IncomingMessage, res: ServerResponse) => void {
  const table = routes(ctx);
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const hits = table.flatMap((route) => {
      const param = match(route, url.pathname);
      return param === undefined ? [] : [{ route, param }];
    });
    if (method === "OPTIONS") {
      applyCors(hits[0]?.route.cors ?? "configured", req, res, ctx.config.corsOrigins);
      res.writeHead(204);
      res.end();
      return;
    }
    const hit = hits.find((h) => h.route.method === method);
    if (hit) {
      applyCors(hit.route.cors, req, res, ctx.config.corsOrigins);
      await hit.route.handle(req, res, hit.param);
      return;
    }
    if (hits.length > 0) return json(res, 405, { error: "method-not-allowed" });
    if (ctx.config.webDir !== undefined && (await serveStatic(ctx.config.webDir, method, url.pathname, res))) return;
    if (method === "GET" && url.pathname === "/") return html(res, landingPage({ name: ctx.envName(), version: ctx.config.version, port: ctx.remote({ includePairing: false }).port }));
    json(res, 404, { error: "not-found" });
  };
  return (req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error("[http] request failed", err);
      if (!res.headersSent) json(res, 500, { error: "internal" });
      else res.destroy();
    });
  };
}
