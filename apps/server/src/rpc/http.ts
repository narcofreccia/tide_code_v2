import type { IncomingMessage, ServerResponse } from "node:http";
import type { EnvProbe, PairResponse } from "@tide/contracts";
import type { ServerConfig } from "../config.ts";
import { handleWebhook, WEBHOOK_MAX_BODY, type WebhookDeps } from "../scheduling/webhooks.ts";
import { PROTOCOL_VERSION } from "../version.ts";
import type { ClientTokenStore } from "./clientTokens.ts";
import { hostRefusal, trustedOrigin, type HostPolicy } from "./hostOrigin.ts";
import { RELAY_BUCKET, safeEqual, type PairingCodes } from "./pairing.ts";
import { isLoopbackHost } from "./remote.ts";
import { landingPage, pairPage, type RemoteInfo } from "./remote.ts";
import { serveStatic } from "./static.ts";
import type { TicketIssuer } from "./tickets.ts";

export interface HttpContext {
  config: ServerConfig;
  tickets: TicketIssuer;
  pairing: PairingCodes;
  /** R17: per-device tokens minted by pairing; they buy tickets like the master token */
  clientTokens: ClientTokenStore;
  remote: (options: { includePairing: boolean }) => RemoteInfo;
  /** settings.environment.name, read per request (the user may rename the machine) */
  envName: () => string;
  webhook: WebhookDeps;
  /** R18: which Host names this server answers to (hostOrigin.ts) */
  hosts: HostPolicy;
  /** R18: the configured relay's http origin, read per request; undefined = no relay configured */
  relayOrigin?: () => string | undefined;
}

/**
 * R18. `trusted`: the request's Origin is echoed only when `trustedOrigin` accepts it (loopback,
 * LAN, Tauri, this server's own pages, configured origins, the relay); public probe routes and
 * pairing. `bearer`: any Origin is echoed (with `Vary: Origin`) because the bearer token is the
 * guard and legitimate clients live on many origins. `none`: no CORS headers.
 */
type Cors = "trusted" | "bearer" | "none";

interface Route {
  method: "GET" | "POST";
  /** exact path, or a prefix ending in "/" whose remainder becomes `param` */
  path: string;
  cors: Cors;
  handle(req: IncomingMessage, res: ServerResponse, param: string): void | Promise<void>;
}

const PAIR_BODY_MAX = 1024;
export const CLIENT_NAME_MAX = 64;
const DEFAULT_CLIENT_NAME = "device";

/** `{ clientId? }` for a valid bearer (master or a live client token), undefined otherwise. */
function bearerGrant(ctx: HttpContext, header: string | undefined): { clientId?: string } | undefined {
  const auth = header ?? "";
  if (safeEqual(auth, `Bearer ${ctx.config.token}`)) return {};
  const match = /^Bearer (\S+)$/.exec(auth);
  const clientId = match?.[1] !== undefined ? ctx.clientTokens.resolve(match[1]) : undefined;
  return clientId === undefined ? undefined : { clientId };
}

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

/**
 * R18: true when the relay client on this machine made this request: it dials loopback and sets
 * `x-tide-relay: 1`. The header is believed only from a loopback peer while a relay is configured;
 * anywhere else it is ignored (a direct client cannot borrow the relay's bucket).
 */
export function isRelayed(ctx: Pick<HttpContext, "relayOrigin">, req: IncomingMessage): boolean {
  if (req.headers["x-tide-relay"] !== "1" || ctx.relayOrigin?.() === undefined) return false;
  const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  return isLoopbackHost(peer) || peer.startsWith("127.");
}

function originTrusted(ctx: HttpContext, req: IncomingMessage): boolean {
  return trustedOrigin(req.headers.origin, { host: req.headers.host, hosts: ctx.hosts, corsOrigins: ctx.config.corsOrigins, relayOrigin: ctx.relayOrigin?.() });
}

function applyCors(cors: Cors, req: IncomingMessage, res: ServerResponse, ctx: HttpContext): void {
  const origin = req.headers.origin;
  if (origin === undefined || cors === "none") return;
  if (cors === "trusted" && !originTrusted(ctx, req)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
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
      cors: "trusted",
      handle: (_req, res) => json(res, 200, { ok: true, environmentId: config.environmentId, version: config.version }),
    },
    {
      method: "GET",
      path: "/api/env",
      cors: "trusted",
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
      cors: "bearer",
      handle: (req, res) => {
        const grant = bearerGrant(ctx, req.headers.authorization);
        if (grant === undefined) return json(res, 401, { error: "unauthorized" });
        if (grant.clientId !== undefined) ctx.clientTokens.use(grant.clientId);
        json(res, 200, ctx.tickets.issue("websocket", grant));
      },
    },
    {
      method: "POST",
      path: "/api/auth/pair",
      cors: "trusted",
      handle: async (req, res) => {
        if (!originTrusted(ctx, req)) return refuseOrigin(res);
        const raw = await readBody(req, PAIR_BODY_MAX);
        if (raw === "too-large") return json(res, 413, { error: "payload-too-large" });
        let code: unknown;
        let name: unknown;
        try {
          ({ code, name } = JSON.parse(raw.toString("utf8")) as { code?: unknown; name?: unknown });
        } catch {
          return json(res, 400, { error: "invalid-params", message: "body must be JSON {code, name?}" });
        }
        if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) return json(res, 400, { error: "invalid-params", message: "code must be 6 digits" });
        if (name !== undefined && (typeof name !== "string" || name.trim().length > CLIENT_NAME_MAX)) {
          return json(res, 400, { error: "invalid-params", message: `name must be a string of at most ${CLIENT_NAME_MAX} characters` });
        }
        // relayed attempts arrive from loopback: they share one stricter bucket (pairing.ts)
        const address = isRelayed(ctx, req) ? RELAY_BUCKET : (req.socket.remoteAddress ?? "unknown");
        const redeemed = ctx.pairing.redeem(code.trim(), address);
        if (redeemed.outcome === "rate-limited") {
          res.setHeader("Retry-After", "60");
          return json(res, 429, { error: "rate-limited" });
        }
        if (redeemed.outcome === "invalid") return json(res, 401, { error: "invalid-code" });
        const deviceName = typeof name === "string" && name.trim() !== "" ? name.trim() : DEFAULT_CLIENT_NAME;
        const minted = ctx.clientTokens.mint(deviceName, address, redeemed.access);
        const body: PairResponse = { environmentId: config.environmentId, name: ctx.envName(), token: minted.token, clientId: minted.id, access: redeemed.access };
        json(res, 200, body);
      },
    },
    {
      method: "POST",
      path: "/hook/",
      cors: "none",
      handle: async (req, res, hookId) => {
        if (!originTrusted(ctx, req)) return refuseOrigin(res);
        const raw = await readBody(req, WEBHOOK_MAX_BODY);
        if (raw === "too-large") return json(res, 413, { error: "payload-too-large" });
        const result = await handleWebhook(ctx.webhook, hookId, raw, req.headers);
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(result.body);
      },
    },
  ];
}

function refuseOrigin(res: ServerResponse): void {
  json(res, 403, { error: "forbidden", message: "this endpoint does not accept requests from a page on that origin" });
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
    if (!ctx.hosts.allowsHost(req.headers.host)) {
      res.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
      res.end(hostRefusal(req.headers.host));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const hits = table.flatMap((route) => {
      const param = match(route, url.pathname);
      return param === undefined ? [] : [{ route, param }];
    });
    if (method === "OPTIONS") {
      applyCors(hits[0]?.route.cors ?? "trusted", req, res, ctx);
      res.writeHead(204);
      res.end();
      return;
    }
    const hit = hits.find((h) => h.route.method === method);
    if (hit) {
      applyCors(hit.route.cors, req, res, ctx);
      await hit.route.handle(req, res, hit.param);
      return;
    }
    if (hits.length > 0) return json(res, 405, { error: "method-not-allowed" });
    if (ctx.config.webDir !== undefined && (await serveStatic(ctx.config.webDir, method, url.pathname, res))) return;
    if (method === "GET" && url.pathname === "/") {
      const remote = ctx.remote({ includePairing: false });
      return html(res, landingPage({ name: ctx.envName(), version: ctx.config.version, port: remote.port, tls: remote.tls === true }));
    }
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
