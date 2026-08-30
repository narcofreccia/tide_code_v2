import type {
  RpcChunk,
  RpcError,
  RpcFrame,
  RpcInput,
  RpcOutput,
  StreamMethodName,
  UnaryMethodName,
} from "@tide/contracts";

export type ConnectionStatus = "connecting" | "open" | "closed" | "reconnecting";

export type TideAuth =
  | { kind: "token"; token: string }
  | { kind: "ticket"; getTicket: () => Promise<string> };

export interface BackoffOptions {
  /** first retry delay in ms */
  minMs?: number;
  /** ceiling for the exponential growth */
  maxMs?: number;
  /** 0..1 fraction of the delay that is randomised */
  jitter?: number;
}

export interface TideConnectionOptions {
  url: string;
  auth: TideAuth;
  /** injectable for tests / non-browser hosts; defaults to globalThis.WebSocket */
  webSocketImpl?: typeof WebSocket;
  backoff?: BackoffOptions;
  /** injectable timers so tests do not have to wait out the backoff */
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  random?: () => number;
}

export class RpcCallError extends Error {
  readonly code: string;
  readonly data: unknown;
  constructor(error: RpcError) {
    super(error.message);
    this.name = "RpcCallError";
    this.code = error.code;
    this.data = error.data;
  }
}

export interface StreamHandle {
  id: string;
  cancel(): void;
  /** resolves when the server sends `end`, rejects on an error frame or a disconnect */
  done: Promise<void>;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

interface ActiveStream {
  onChunk: (chunk: unknown) => void;
  resolve: () => void;
  reject: (err: unknown) => void;
  settled: boolean;
}

const DISCONNECTED: RpcError = { code: "disconnected", message: "connection lost" };

function randomPrefix(random: () => number): string {
  return Math.floor(random() * 0xffffff)
    .toString(36)
    .padStart(4, "0");
}

/**
 * Multiplexed JSON-RPC-ish client over a single WebSocket, with reconnect.
 * Streams are deliberately NOT auto-resumed here: only the store layer knows
 * how to resume them (with `fromSeq`) without losing or duplicating events.
 */
export class TideConnection {
  private readonly opts: TideConnectionOptions;
  private readonly ws: typeof WebSocket;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly random: () => number;
  private readonly backoff: Required<BackoffOptions>;

  private socket: WebSocket | undefined;
  private statusValue: ConnectionStatus = "closed";
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly streams = new Map<string, ActiveStream>();
  private outbox: string[] = [];

  private idPrefix: string;
  private idCounter = 0;
  private attempt = 0;
  private retryHandle: unknown;
  private closedByUser = false;
  private openWaiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];

  constructor(opts: TideConnectionOptions) {
    this.opts = opts;
    const impl = opts.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!impl) throw new Error("No WebSocket implementation available");
    this.ws = impl;
    this.setTimer = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.random = opts.random ?? Math.random;
    this.backoff = {
      minMs: opts.backoff?.minMs ?? 500,
      maxMs: opts.backoff?.maxMs ?? 10_000,
      jitter: opts.backoff?.jitter ?? 0.3,
    };
    this.idPrefix = randomPrefix(this.random);
  }

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  on(event: "status", cb: (status: ConnectionStatus) => void): () => void {
    void event;
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  /** Opens the socket; resolves on the first successful open. */
  connect(): Promise<void> {
    this.closedByUser = false;
    if (this.statusValue === "open") return Promise.resolve();
    const waiter = new Promise<void>((resolve, reject) => {
      this.openWaiters.push({ resolve, reject });
    });
    if (this.statusValue === "connecting" || this.statusValue === "reconnecting") return waiter;
    this.setStatus("connecting");
    void this.openSocket();
    return waiter;
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryHandle !== undefined) {
      this.clearTimer(this.retryHandle);
      this.retryHandle = undefined;
    }
    const sock = this.socket;
    this.socket = undefined;
    if (sock) {
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      try {
        sock.close();
      } catch {
        /* already closing */
      }
    }
    this.failInFlight(DISCONNECTED);
    this.outbox = [];
    this.setStatus("closed");
  }

  call<M extends UnaryMethodName>(method: M, params: RpcInput<M>): Promise<RpcOutput<M>> {
    const id = this.nextId();
    return new Promise<RpcOutput<M>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ id, method, params });
    });
  }

  stream<M extends StreamMethodName>(
    method: M,
    params: RpcInput<M>,
    onChunk: (chunk: RpcChunk<M>) => void,
  ): StreamHandle {
    const id = this.nextId();
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // a cancelled/failed stream must never leave an unhandled rejection behind
    done.catch(() => undefined);
    this.streams.set(id, {
      onChunk: onChunk as (c: unknown) => void,
      resolve,
      reject,
      settled: false,
    });
    this.send({ id, method, params });
    return {
      id,
      cancel: () => {
        const active = this.streams.get(id);
        this.streams.delete(id);
        if (active && !active.settled) {
          active.settled = true;
          active.resolve();
        }
        if (this.statusValue === "open") {
          this.call("unsubscribe", { id }).catch(() => undefined);
        }
      },
      done,
    };
  }

  // ---- internals ----

  private nextId(): string {
    this.idCounter += 1;
    return `${this.idPrefix}-${this.idCounter}`;
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.statusValue === next) return;
    this.statusValue = next;
    for (const cb of this.statusListeners) cb(next);
  }

  private send(frame: { id: string; method: string; params: unknown }): void {
    const payload = JSON.stringify(frame);
    if (this.socket && this.statusValue === "open") this.socket.send(payload);
    else this.outbox.push(payload);
  }

  private async authUrl(): Promise<string> {
    const url = new URL(this.opts.url);
    if (this.opts.auth.kind === "token") url.searchParams.set("token", this.opts.auth.token);
    else url.searchParams.set("wsTicket", await this.opts.auth.getTicket());
    return url.toString();
  }

  private async openSocket(): Promise<void> {
    let target: string;
    try {
      target = await this.authUrl();
    } catch (err) {
      this.rejectOpenWaiters(err);
      this.scheduleRetry();
      return;
    }
    if (this.closedByUser) return;

    let sock: WebSocket;
    try {
      sock = new this.ws(target);
    } catch (err) {
      this.rejectOpenWaiters(err);
      this.scheduleRetry();
      return;
    }
    this.socket = sock;

    sock.onopen = () => {
      if (this.socket !== sock) return;
      this.attempt = 0;
      this.setStatus("open");
      const queued = this.outbox;
      this.outbox = [];
      for (const p of queued) sock.send(p);
      const waiters = this.openWaiters;
      this.openWaiters = [];
      for (const w of waiters) w.resolve();
    };
    sock.onmessage = (ev: MessageEvent) => {
      if (this.socket !== sock) return;
      this.handleMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
    };
    sock.onerror = () => {
      /* close always follows; nothing to do here */
    };
    sock.onclose = () => {
      if (this.socket !== sock) return;
      this.socket = undefined;
      this.failInFlight(DISCONNECTED);
      if (this.closedByUser) {
        this.setStatus("closed");
        return;
      }
      this.setStatus("reconnecting");
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.closedByUser) return;
    this.setStatus("reconnecting");
    const exp = Math.min(this.backoff.maxMs, this.backoff.minMs * 2 ** this.attempt);
    this.attempt += 1;
    const delay = Math.round(exp * (1 - this.backoff.jitter * this.random()));
    this.retryHandle = this.setTimer(() => {
      this.retryHandle = undefined;
      void this.openSocket();
    }, delay);
  }

  private rejectOpenWaiters(err: unknown): void {
    const waiters = this.openWaiters;
    this.openWaiters = [];
    for (const w of waiters) w.reject(err);
  }

  /** Pending unary calls reject; streams reject so the owner can resume them. */
  private failInFlight(error: RpcError): void {
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const c of calls) c.reject(new RpcCallError(error));
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const s of streams) {
      if (s.settled) continue;
      s.settled = true;
      s.reject(new RpcCallError(error));
    }
  }

  private handleMessage(raw: string): void {
    let frame: RpcFrame;
    try {
      frame = JSON.parse(raw) as RpcFrame;
    } catch {
      return;
    }
    if (typeof frame?.id !== "string") return;

    if ("chunk" in frame) {
      this.streams.get(frame.id)?.onChunk(frame.chunk);
      return;
    }
    if ("end" in frame) {
      const s = this.streams.get(frame.id);
      this.streams.delete(frame.id);
      if (s && !s.settled) {
        s.settled = true;
        s.resolve();
      }
      return;
    }
    if ("error" in frame) {
      const err = new RpcCallError(frame.error);
      const call = this.pending.get(frame.id);
      if (call) {
        this.pending.delete(frame.id);
        call.reject(err);
        return;
      }
      const s = this.streams.get(frame.id);
      this.streams.delete(frame.id);
      if (s && !s.settled) {
        s.settled = true;
        s.reject(err);
      }
      return;
    }
    const call = this.pending.get(frame.id);
    if (!call) return;
    this.pending.delete(frame.id);
    call.resolve(frame.result);
  }
}
