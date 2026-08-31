import WebSocket from "ws";
import type { RpcError, RpcFrame } from "@tide/contracts";

/** Minimal promise-based RPC client for server tests: no sleeps, no polling. */
export class WsTestClient {
  #ws: WebSocket;
  #nextId = 0;
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on("message", (data) => this.#onFrame(JSON.parse(data.toString()) as RpcFrame));
    ws.on("close", () => {
      for (const p of this.#pending.values()) p.reject(new Error("socket closed"));
      this.#pending.clear();
    });
  }

  static open(url: string): Promise<WsTestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once("open", () => resolve(new WsTestClient(ws)));
      ws.once("error", reject);
      ws.once("close", (code) => reject(new Error(`closed ${code}`)));
    });
  }

  #onFrame(frame: RpcFrame): void {
    const pending = this.#pending.get(frame.id);
    if (!pending) return;
    this.#pending.delete(frame.id);
    if ("error" in frame) pending.reject(frame.error);
    else if ("result" in frame) pending.resolve(frame.result);
  }

  call<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = `r${++this.#nextId}`;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Resolves with the RpcError a call is expected to fail with. */
  async expectError(method: string, params: unknown): Promise<RpcError> {
    try {
      await this.call(method, params);
    } catch (err) {
      return err as RpcError;
    }
    throw new Error(`${method} unexpectedly succeeded`);
  }

  close(): void {
    this.#ws.close();
  }
}
