import { StringDecoder } from "node:string_decoder";
import { ACP_ERROR, type ChildLike, type JsonRpcError, type JsonRpcMessage, type LineSource, type TimerLike } from "./types.ts";

/**
 * Newline-delimited JSON-RPC 2.0 over an ACP agent's stdio. stdout carries the protocol;
 * anything on it that is not JSON (a stray banner, a log line) is logged and skipped, stderr is
 * logged. Both directions issue requests: the client calls `session/*`, the agent calls
 * `session/request_permission` and `fs/*`, which `onRequest` answers (sync or async).
 */

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(error: JsonRpcError) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
}

/** A handler throws this to answer the agent with a specific JSON-RPC error. */
export function rpcError(code: number, message: string): RpcError {
  return new RpcError({ code, message });
}

export function splitLines(buffer: string, onLine: (line: string) => void): string {
  let rest = buffer;
  for (;;) {
    const index = rest.indexOf("\n");
    if (index === -1) return rest;
    let line = rest.slice(0, index);
    rest = rest.slice(index + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim() !== "") onLine(line);
  }
}

export function readLines(stream: LineSource, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    buffer = splitLines(buffer, onLine);
  });
  stream.on("end", () => {
    buffer += decoder.end();
    splitLines(`${buffer}\n`, onLine);
    buffer = "";
  });
}

export const KILL_GRACE_MS = 5_000;

const REAL_TIMERS: TimerLike = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ConnectionOptions {
  label: string;
  log: (message: string, data?: unknown) => void;
  onNotification: (method: string, params: unknown) => void;
  /** answers an agent→client request; throw `rpcError(...)` for a JSON-RPC error */
  onRequest: (method: string, params: unknown) => unknown;
  /** the child died on its own (not through `close()`) */
  onExit?: (error: Error) => void;
  timers?: TimerLike;
  killGraceMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: unknown;
}

export class AcpConnection {
  #child: ChildLike;
  #options: ConnectionOptions;
  #timers: TimerLike;
  #pending = new Map<number, Pending>();
  #nextId = 0;
  #dead: Error | undefined;
  #closing = false;
  #exited = false;
  #killTimer: unknown;

  constructor(child: ChildLike, options: ConnectionOptions) {
    this.#child = child;
    this.#options = options;
    this.#timers = options.timers ?? REAL_TIMERS;
    if (child.stdout) readLines(child.stdout, (line) => this.#line(line));
    if (child.stderr) readLines(child.stderr, (line) => options.log(`[${options.label}:stderr] ${line}`));
    child.once("exit", ((code: number | null, signal: string | null) => this.#died(new Error(`${options.label} exited (${code ?? signal ?? "unknown"})`))) as never);
    child.once("error", ((error: Error) => this.#died(error)) as never);
  }

  get dead(): Error | undefined {
    return this.#dead;
  }

  #line(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      this.#options.log(`[${this.#options.label}] non-JSON stdout line skipped: ${raw.slice(0, 200)}`);
      return;
    }
    if (typeof message !== "object" || message === null) return;
    if (typeof message.method === "string") {
      if (message.id === undefined || message.id === null) this.#options.onNotification(message.method, message.params);
      else void this.#answer(message.id, message.method, message.params);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (pending.timer !== undefined) this.#timers.clearTimeout(pending.timer);
      if (message.error) pending.reject(new RpcError(message.error));
      else pending.resolve(message.result);
    }
  }

  async #answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.#options.onRequest(method, params);
      this.#write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : ACP_ERROR.internal;
      const message = error instanceof Error ? error.message : String(error);
      this.#write({ jsonrpc: "2.0", id, error: { code, message } });
    }
  }

  #write(message: JsonRpcMessage): void {
    if (this.#dead) return;
    try {
      this.#child.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.#options.log(`[${this.#options.label}] write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.#dead) return Promise.reject(this.#dead);
    const id = this.#nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const pending: Pending = { method, resolve: resolve as (value: unknown) => void, reject };
      if (timeoutMs !== undefined) {
        pending.timer = this.#timers.setTimeout(() => {
          if (!this.#pending.delete(id)) return;
          reject(new Error(`${this.#options.label}: ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }
      this.#pending.set(id, pending);
    });
    this.#write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #fail(error: Error): void {
    this.#dead ??= error;
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) this.#timers.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #died(error: Error): void {
    const first = !this.#exited;
    this.#exited = true;
    this.#fail(error);
    if (this.#killTimer !== undefined) {
      this.#timers.clearTimeout(this.#killTimer);
      this.#killTimer = undefined;
    }
    if (first && !this.#closing) this.#options.onExit?.(error);
  }

  /** Closes stdin, SIGTERMs the process (group), SIGKILLs it after a grace period. */
  close(): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#fail(this.#dead ?? new Error(`${this.#options.label} session closed`));
    try {
      this.#child.stdin?.end();
    } catch {
      // already closed
    }
    if (this.#exited) return;
    try {
      this.#child.kill("SIGTERM");
    } catch {
      return;
    }
    if (this.#exited) return;
    this.#killTimer = this.#timers.setTimeout(() => {
      this.#killTimer = undefined;
      if (this.#exited) return;
      try {
        this.#child.kill("SIGKILL");
      } catch {
        // gone
      }
    }, this.#options.killGraceMs ?? KILL_GRACE_MS);
  }
}
