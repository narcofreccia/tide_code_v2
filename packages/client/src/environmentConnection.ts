import type {
  EnvRoute,
  RpcChunk,
  RpcInput,
  RpcOutput,
  ServerInfo,
  StreamMethodName,
  UnaryMethodName,
} from "@tide/contracts";
import {
  RpcCallError,
  TideConnection,
  UNAUTHORIZED_CLOSE,
  type BackoffOptions,
  type ConnectionStatus,
  type StreamHandle,
  type TideAuth,
  type TideConnectionOptions,
} from "./connection.ts";
import { createModelStore, type ModelStore, type ModelStoreConnection } from "./modelStore.ts";
import {
  UnauthorizedError,
  defaultFetch,
  errorMessage,
  preflight,
  realTimers,
  ticketGetter,
  type FetchLike,
  type PreflightResult,
  type Timers,
} from "./preflight.ts";
import { httpOriginFor, sortRoutes } from "./urls.ts";

export type EnvConnectionState = "connecting" | "connected" | "unauthorized" | "offline";

export interface EnvConnectionSnapshot {
  state: EnvConnectionState;
  /** the route carrying the connection (the last one used while offline) */
  route?: EnvRoute;
  /** who answered: probe / server.info. With `verifyId: false` it may differ from `id`. */
  environmentId?: string;
  info?: ServerInfo;
  error?: string;
  lastSeenAt?: number;
}

/** What EnvironmentConnection needs from a socket; TideConnection satisfies it. */
export interface SocketLike extends ModelStoreConnection {
  connect(): Promise<void>;
  close(): void;
  readonly lastCloseCode: number | undefined;
}

export interface EnvironmentConnectionOptions {
  /** the environment id this connection expects to reach */
  id: string;
  /**
   * true (default): a route whose `/api/env` names another environment is skipped.
   * false: the local environment — whatever answers on its route is it (the id follows).
   */
  verifyId?: boolean;
  routes: EnvRoute[];
  token?: string;
  /** "token" = raw token on the socket (server --dev); "ticket" = POST /api/auth/ws-ticket first */
  authMode?: "token" | "ticket";
  fetchImpl?: FetchLike;
  webSocketImpl?: typeof WebSocket;
  /** test seam */
  createSocket?: (opts: TideConnectionOptions) => SocketLike;
  timers?: Timers;
  random?: () => number;
  now?: () => number;
  preflightTimeoutMs?: number;
  /** while connected over a worse route, how often better ones are re-probed */
  upgradeIntervalMs?: number;
  /** `server.info` refresh while connected */
  infoIntervalMs?: number;
  backoff?: BackoffOptions;
}

type Waiter = { resolve: (s: SocketLike) => void; reject: (e: unknown) => void };

/**
 * One environment (one tide-server): walks its routes by priority with a `/api/env`
 * preflight, holds one socket on the best route that answers as the right environment,
 * retries drops with backoff (re-walking the routes), stops on 4401 until the token
 * changes, and moves to a better route when one comes back. Its ModelStore survives route
 * switches: the store sees `reconnecting` → `open` and resumes with `fromSeq`.
 */
export class EnvironmentConnection {
  readonly id: string;
  readonly store: ModelStore;

  private routes: EnvRoute[];
  private token: string | undefined;
  private readonly verifyId: boolean;
  private readonly authMode: "token" | "ticket";
  private readonly fetchImpl: FetchLike;
  private readonly createSocket: (opts: TideConnectionOptions) => SocketLike;
  private readonly webSocketImpl: typeof WebSocket | undefined;
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly preflightTimeoutMs: number;
  private readonly upgradeIntervalMs: number;
  private readonly infoIntervalMs: number;
  private readonly backoff: Required<BackoffOptions>;

  private snap: EnvConnectionSnapshot = { state: "connecting" };
  private readonly listeners = new Set<(s: EnvConnectionSnapshot) => void>();
  private socket: SocketLike | undefined;
  private offSocket: (() => void) | undefined;
  private facadeStatus: ConnectionStatus = "closed";
  private readonly facadeListeners = new Set<(s: ConnectionStatus) => void>();
  private waiters: Waiter[] = [];
  private generation = 0;
  private running = false;
  private attempt = 0;
  private retryTimer: unknown;
  private upgradeTimer: unknown;
  private infoTimer: unknown;
  private deferredIds = 0;

  constructor(opts: EnvironmentConnectionOptions) {
    this.id = opts.id;
    this.routes = [...opts.routes];
    this.token = opts.token;
    this.verifyId = opts.verifyId ?? true;
    this.authMode = opts.authMode ?? "ticket";
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.webSocketImpl = opts.webSocketImpl;
    this.createSocket = opts.createSocket ?? ((o) => new TideConnection(o));
    this.timers = opts.timers ?? realTimers;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.preflightTimeoutMs = opts.preflightTimeoutMs ?? 2000;
    this.upgradeIntervalMs = opts.upgradeIntervalMs ?? 60_000;
    this.infoIntervalMs = opts.infoIntervalMs ?? 30_000;
    this.backoff = {
      minMs: opts.backoff?.minMs ?? 1000,
      maxMs: opts.backoff?.maxMs ?? 30_000,
      jitter: opts.backoff?.jitter ?? 0.3,
    };
    const self = this;
    const facade: ModelStoreConnection = {
      get status() {
        return self.facadeStatus;
      },
      on: (_event, cb) => {
        self.facadeListeners.add(cb);
        return () => self.facadeListeners.delete(cb);
      },
      call: (method, params) => self.call(method, params),
      stream: (method, params, onChunk) => self.stream(method, params, onChunk),
    };
    this.store = createModelStore(facade);
  }

  get snapshot(): EnvConnectionSnapshot {
    return this.snap;
  }

  onChange(cb: (s: EnvConnectionSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.restart();
  }

  /** Final: closes the socket, rejects waiters and disposes the store. */
  stop(): void {
    this.running = false;
    this.generation += 1;
    this.clearTimers();
    this.dropSocket();
    this.setFacade("closed");
    this.rejectWaiters(new RpcCallError({ code: "disconnected", message: "environment removed" }));
    this.store.dispose();
    this.listeners.clear();
  }

  /** A new token always re-walks: it is the only way out of `unauthorized`. */
  setToken(token: string | undefined): void {
    if (token === this.token) return;
    this.token = token;
    if (this.running) this.restart();
  }

  setRoutes(routes: EnvRoute[]): void {
    this.routes = [...routes];
    if (!this.running) return;
    const current = this.snap.route;
    if (this.snap.state === "connected" && current && routes.some((r) => r.url === current.url)) {
      this.scheduleUpgrade();
      return;
    }
    this.restart();
  }

  /** Re-walk now (user asked to probe, or a better route may be up). Keeps a live socket. */
  probe(): void {
    if (!this.running) return;
    if (this.snap.state === "connected") {
      const current = this.snap.route;
      const better = current ? this.betterRoutes(current) : [];
      if (better.length > 0) void this.tryUpgrade(better);
      return;
    }
    this.restart();
  }

  call<M extends UnaryMethodName>(method: M, params: RpcInput<M>): Promise<RpcOutput<M>> {
    return this.ready().then((sock) => sock.call(method, params));
  }

  stream<M extends StreamMethodName>(
    method: M,
    params: RpcInput<M>,
    onChunk: (chunk: RpcChunk<M>) => void,
  ): StreamHandle {
    if (this.socket && this.snap.state === "connected") return this.socket.stream(method, params, onChunk);
    // not up yet: open it once connected, or fail like a dropped stream
    let inner: StreamHandle | undefined;
    let cancelled = false;
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    done.catch(() => undefined);
    this.ready().then((sock) => {
      if (cancelled) return;
      inner = sock.stream(method, params, onChunk);
      inner.done.then(resolve, reject);
    }, reject);
    this.deferredIds += 1;
    return {
      id: `deferred-${this.deferredIds}`,
      cancel: () => {
        cancelled = true;
        inner?.cancel();
        resolve();
      },
      done,
    };
  }

  // ---- walking ----

  private restart(): void {
    this.clearTimers();
    this.dropSocket();
    this.set({ state: "connecting", error: undefined });
    void this.walk();
  }

  private async walk(): Promise<void> {
    this.generation += 1;
    const gen = this.generation;
    const routes = sortRoutes(this.routes);
    const probes = routes.map((r) => preflight(r, this.fetchImpl, this.preflightTimeoutMs, this.timers));
    const fallback: EnvRoute[] = [];
    let chosen: EnvRoute | undefined;
    let lastError = routes.length === 0 ? "no routes" : "no route answered";
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i]!;
      const res: PreflightResult = await probes[i]!;
      if (gen !== this.generation) return;
      if (res.kind === "ok") {
        if (!this.verifyId || res.probe.environmentId === this.id) {
          chosen = route;
          if (res.probe.environmentId !== this.snap.environmentId) this.set({ environmentId: res.probe.environmentId });
          break;
        }
        lastError = `${route.url} answers as another environment (${res.probe.name})`;
        continue;
      }
      // no EnvProbe: an older server, or a CORS-blocked preflight against the local server
      if (res.kind === "unknown" || route.kind === "local") fallback.push(route);
      lastError = `${route.url}: ${res.kind === "unknown" ? `HTTP ${res.status}` : res.error}`;
    }
    for (const route of chosen ? [chosen] : fallback) {
      const outcome = await this.open(route, gen);
      if (outcome === "done") return;
      lastError = `${route.url}: ${outcome}`;
    }
    this.fail(gen, lastError);
  }

  private auth(route: EnvRoute): TideAuth {
    const token = this.token ?? "";
    if (this.authMode === "token") return { kind: "token", token };
    return { kind: "ticket", getTicket: ticketGetter(httpOriginFor(route.url), token, this.fetchImpl) };
  }

  private newSocket(route: EnvRoute): SocketLike {
    return this.createSocket({
      url: route.url,
      auth: this.auth(route),
      reconnect: false,
      random: this.random,
      setTimeoutImpl: this.timers.setTimeout,
      clearTimeoutImpl: this.timers.clearTimeout,
      ...(this.webSocketImpl ? { webSocketImpl: this.webSocketImpl } : {}),
    });
  }

  /** "done" when connected, unauthorized or superseded; otherwise the failure text. */
  private async open(route: EnvRoute, gen: number): Promise<"done" | string> {
    const sock = this.newSocket(route);
    try {
      await sock.connect();
    } catch (err) {
      sock.close();
      if (gen !== this.generation) return "done";
      if (isUnauthorized(err, sock)) {
        this.set({ route });
        this.unauthorized();
        return "done";
      }
      return errorMessage(err);
    }
    if (gen !== this.generation) {
      sock.close();
      return "done";
    }
    this.adopt(sock, route);
    return "done";
  }

  private adopt(sock: SocketLike, route: EnvRoute): void {
    const previous = this.socket;
    this.offSocket?.();
    this.socket = sock;
    this.offSocket = sock.on("status", (status) => {
      if (status === "closed" || status === "reconnecting") this.onDrop(sock);
    });
    this.attempt = 0;
    if (previous) {
      this.setFacade("reconnecting");
      previous.close();
    }
    this.set({ state: "connected", route, error: undefined, lastSeenAt: this.now() });
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.resolve(sock);
    this.setFacade("open");
    this.scheduleUpgrade();
    this.refreshInfo();
  }

  private onDrop(sock: SocketLike): void {
    if (sock !== this.socket) return;
    this.dropSocket();
    this.clearTimers();
    if (sock.lastCloseCode === UNAUTHORIZED_CLOSE) this.unauthorized();
    else this.fail(this.generation, "connection lost");
  }

  private unauthorized(): void {
    this.generation += 1; // nothing in flight may resurrect the connection
    this.clearTimers();
    this.set({ state: "unauthorized", error: "unauthorized: the token was refused (pair again)" });
    this.rejectWaiters(new RpcCallError({ code: "unauthorized", message: "unauthorized" }));
  }

  private fail(gen: number, error: string): void {
    if (gen !== this.generation || !this.running) return;
    this.set({ state: "offline", error });
    this.rejectWaiters(new RpcCallError({ code: "disconnected", message: error }));
    const exp = Math.min(this.backoff.maxMs, this.backoff.minMs * 2 ** this.attempt);
    this.attempt += 1;
    const delay = Math.round(exp * (1 - this.backoff.jitter * this.random()));
    this.clearTimer("retryTimer");
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.running && gen === this.generation) void this.walk();
    }, delay);
  }

  // ---- while connected ----

  private betterRoutes(current: EnvRoute): EnvRoute[] {
    return sortRoutes(this.routes).filter((r) => r.priority < current.priority && r.url !== current.url);
  }

  private scheduleUpgrade(): void {
    this.clearTimer("upgradeTimer");
    const current = this.snap.route;
    if (!current || this.betterRoutes(current).length === 0) return;
    this.upgradeTimer = this.timers.setTimeout(() => {
      this.upgradeTimer = undefined;
      const route = this.snap.route;
      if (route) void this.tryUpgrade(this.betterRoutes(route));
    }, this.upgradeIntervalMs);
  }

  private async tryUpgrade(candidates: EnvRoute[]): Promise<void> {
    const gen = this.generation;
    const sock = this.socket;
    const stale = (): boolean => gen !== this.generation || sock !== this.socket || this.snap.state !== "connected";
    const probes = candidates.map((r) => preflight(r, this.fetchImpl, this.preflightTimeoutMs, this.timers));
    const expected = this.verifyId ? this.id : this.snap.environmentId;
    for (let i = 0; i < candidates.length; i++) {
      const res = await probes[i]!;
      if (stale()) return;
      if (res.kind !== "ok" || (expected !== undefined && res.probe.environmentId !== expected)) continue;
      const next = this.newSocket(candidates[i]!);
      try {
        await next.connect();
      } catch {
        next.close();
        continue;
      }
      if (stale()) {
        next.close();
        return;
      }
      this.adopt(next, candidates[i]!);
      return;
    }
    if (!stale()) this.scheduleUpgrade();
  }

  private refreshInfo(): void {
    this.clearTimer("infoTimer");
    const sock = this.socket;
    if (!sock) return;
    sock
      .call("server.info", {})
      .then((info) => {
        if (sock !== this.socket) return;
        if (this.verifyId && info.environmentId !== this.id) {
          this.dropSocket();
          this.clearTimers();
          this.fail(this.generation, `${this.snap.route?.url ?? "route"} reaches environment ${info.environmentId}`);
          return;
        }
        this.set({ info, environmentId: info.environmentId, lastSeenAt: this.now() });
      })
      .catch(() => undefined)
      .finally(() => {
        if (sock !== this.socket) return;
        this.infoTimer = this.timers.setTimeout(() => {
          this.infoTimer = undefined;
          this.refreshInfo();
        }, this.infoIntervalMs);
      });
  }

  // ---- plumbing ----

  private ready(): Promise<SocketLike> {
    if (this.socket && this.snap.state === "connected") return Promise.resolve(this.socket);
    if (this.running && this.snap.state === "connecting") {
      return new Promise<SocketLike>((resolve, reject) => this.waiters.push({ resolve, reject }));
    }
    const code = this.snap.state === "unauthorized" ? "unauthorized" : "disconnected";
    return Promise.reject(new RpcCallError({ code, message: this.snap.error ?? "environment offline" }));
  }

  private rejectWaiters(err: unknown): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(err);
  }

  private dropSocket(): void {
    this.offSocket?.();
    this.offSocket = undefined;
    const sock = this.socket;
    this.socket = undefined;
    if (sock) {
      this.setFacade("reconnecting");
      sock.close();
    }
  }

  /** `undefined` values clear the field */
  private set(patch: { [K in keyof EnvConnectionSnapshot]?: EnvConnectionSnapshot[K] | undefined }): void {
    const next: EnvConnectionSnapshot = { ...this.snap };
    for (const [key, value] of Object.entries(patch) as [keyof EnvConnectionSnapshot, unknown][]) {
      if (value === undefined) delete next[key];
      else (next as unknown as Record<string, unknown>)[key] = value;
    }
    this.snap = next;
    for (const cb of [...this.listeners]) cb(next);
  }

  private setFacade(status: ConnectionStatus): void {
    if (this.facadeStatus === status) return;
    this.facadeStatus = status;
    for (const cb of [...this.facadeListeners]) cb(status);
  }

  private clearTimer(key: "retryTimer" | "upgradeTimer" | "infoTimer"): void {
    const handle = this[key];
    if (handle !== undefined) this.timers.clearTimeout(handle);
    this[key] = undefined;
  }

  private clearTimers(): void {
    this.clearTimer("retryTimer");
    this.clearTimer("upgradeTimer");
    this.clearTimer("infoTimer");
  }
}

function isUnauthorized(err: unknown, sock: SocketLike): boolean {
  if (err instanceof UnauthorizedError) return true;
  if (sock.lastCloseCode === UNAUTHORIZED_CLOSE) return true;
  return err instanceof RpcCallError && err.code === "unauthorized";
}
