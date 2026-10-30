import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  id: string;
  method: string;
  params: unknown;
}

/** In-process RPC server used by the connection tests. */
export class FakeServer {
  private readonly wss: WebSocketServer;
  readonly requests: FakeRequest[] = [];
  readonly urls: string[] = [];
  sockets: WsSocket[] = [];
  handler: (req: FakeRequest, sock: WsSocket) => void = () => undefined;
  /** runs on every accepted socket (e.g. close it with 4401) */
  onConnect: (sock: WsSocket) => void = () => undefined;

  private constructor(wss: WebSocketServer) {
    this.wss = wss;
    wss.on("connection", (sock, req) => {
      this.sockets.push(sock);
      this.urls.push(req.url ?? "");
      this.onConnect(sock);
      sock.on("message", (raw) => {
        const parsed = JSON.parse(String(raw)) as FakeRequest;
        this.requests.push(parsed);
        this.handler(parsed, sock);
      });
      sock.on("close", () => {
        this.sockets = this.sockets.filter((s) => s !== sock);
      });
    });
  }

  static async start(): Promise<FakeServer> {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    return new FakeServer(wss);
  }

  get url(): string {
    const addr = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${addr.port}/ws`;
  }

  send(sock: WsSocket, frame: unknown): void {
    sock.send(JSON.stringify(frame));
  }

  dropClients(): void {
    for (const s of [...this.sockets]) s.terminate();
    this.sockets = [];
  }

  async stop(): Promise<void> {
    this.dropClients();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

export function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** Manual timers: nothing fires until the test runs it. */
export class FakeTimers {
  private next = 0;
  readonly queue = new Map<number, { fn: () => void; ms: number }>();
  readonly timers = {
    setTimeout: (fn: () => void, ms: number): unknown => {
      this.next += 1;
      this.queue.set(this.next, { fn, ms });
      return this.next;
    },
    clearTimeout: (handle: unknown): void => {
      this.queue.delete(handle as number);
    },
  };

  /** delays of the timers still pending */
  pending(): number[] {
    return [...this.queue.values()].map((t) => t.ms);
  }

  /** runs (and removes) every pending timer with exactly this delay */
  run(ms: number): number {
    let ran = 0;
    for (const [id, t] of [...this.queue]) {
      if (t.ms !== ms) continue;
      this.queue.delete(id);
      t.fn();
      ran += 1;
    }
    return ran;
  }
}
