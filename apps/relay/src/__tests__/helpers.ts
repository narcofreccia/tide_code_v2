import { WebSocket } from "ws";

export interface Msg {
  data: Buffer;
  binary: boolean;
}

/** Collects a socket's messages; next() resolves with the oldest unread one. */
export class Inbox {
  #msgs: Msg[] = [];
  #waiters: ((m: Msg) => void)[] = [];
  constructor(ws: WebSocket) {
    ws.on("message", (data, binary) => {
      const m = { data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), binary };
      const w = this.#waiters.shift();
      if (w) w(m);
      else this.#msgs.push(m);
    });
  }
  next(): Promise<Msg> {
    const m = this.#msgs.shift();
    return m ? Promise.resolve(m) : new Promise((resolve) => this.#waiters.push(resolve));
  }
  async json<T = Record<string, unknown>>(): Promise<T> {
    const m = await this.next();
    if (m.binary) throw new Error("expected a JSON control frame");
    return JSON.parse(m.data.toString("utf8")) as T;
  }
  get size(): number {
    return this.#msgs.length;
  }
}

export const opened = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once("error", reject);
  });

export const closed = (ws: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve({ code: 1006, reason: "" });
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });

/** Resolves with the HTTP status of a refused upgrade. */
export const refused = (ws: WebSocket): Promise<number> =>
  new Promise((resolve, reject) => {
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once("open", () => reject(new Error("upgrade unexpectedly accepted")));
    ws.on("error", () => undefined);
  });

export function dataFrame(channel: number, payload: string | Buffer, binary: boolean): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(channel, 0);
  head.writeUInt8(binary ? 1 : 0, 4);
  return Buffer.concat([head, typeof payload === "string" ? Buffer.from(payload) : payload]);
}

/** A log sink whose lines can be awaited (the relay logs connects/disconnects, never bodies). */
export function logTap(): { log: (msg: string) => void; next: (needle: string) => Promise<string>; lines: string[] } {
  const lines: string[] = [];
  const waiters: { needle: string; resolve: (line: string) => void }[] = [];
  return {
    lines,
    log(msg) {
      lines.push(msg);
      for (const w of [...waiters]) {
        if (msg.includes(w.needle)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    },
    next: (needle) => new Promise((resolve) => waiters.push({ needle, resolve })),
  };
}
