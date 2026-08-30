import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import {
  RpcRequest as RpcRequestSchema,
  rpcMethods,
  type RpcChunk,
  type RpcFrame,
  type RpcInput,
  type RpcOutput,
  type StreamMethodName,
  type UnaryMethodName,
} from "@tide/contracts";

/** Error a handler may throw when it wants a specific wire code. */
export class RpcException extends Error {
  readonly code: string;
  readonly data: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = "RpcException";
    this.code = code;
    this.data = data;
  }
}

export interface RpcCallContext {
  connectionId: string;
  requestId: string;
  /** cancels an active stream on this connection */
  cancelStream(id: string): boolean;
}

type Send = (frame: RpcFrame) => void;
type UnaryFn = (input: unknown, ctx: RpcCallContext) => Promise<unknown>;
type StreamFn = (input: unknown, ctx: RpcCallContext, emit: (chunk: unknown) => void) => Promise<() => void>;

export class RpcRouter {
  #unary = new Map<string, UnaryFn>();
  #streams = new Map<string, StreamFn>();

  register<M extends UnaryMethodName>(
    name: M,
    handler: (input: RpcInput<M>, ctx: RpcCallContext) => Promise<RpcOutput<M>>,
  ): void {
    this.#unary.set(name, handler as UnaryFn);
  }

  registerStream<M extends StreamMethodName>(
    name: M,
    handler: (
      input: RpcInput<M>,
      ctx: RpcCallContext,
      emit: (chunk: RpcChunk<M>) => void,
    ) => Promise<() => void>,
  ): void {
    this.#streams.set(name, handler as StreamFn);
  }

  connection(connectionId: string, send: Send): RpcConnection {
    return new RpcConnection(this.#unary, this.#streams, connectionId, send);
  }
}

/** Per-socket state: tracks in-flight streams so close/unsubscribe can cancel them. */
export class RpcConnection {
  #unary: Map<string, UnaryFn>;
  #streams: Map<string, StreamFn>;
  #connectionId: string;
  #send: Send;
  #active = new Map<string, { cancel: (() => void) | null; closed: boolean }>();
  #closed = false;

  constructor(unary: Map<string, UnaryFn>, streams: Map<string, StreamFn>, connectionId: string, send: Send) {
    this.#unary = unary;
    this.#streams = streams;
    this.#connectionId = connectionId;
    this.#send = send;
  }

  get connectionId(): string {
    return this.#connectionId;
  }

  /** Entry point for a raw socket text frame. */
  async handleMessage(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#error("", "bad-request", "malformed JSON frame");
      return;
    }
    if (!Check(RpcRequestSchema, parsed)) {
      this.#error("", "bad-request", "frame is not an RpcRequest");
      return;
    }
    await this.handleRequest(parsed.id, parsed.method, parsed.params);
  }

  async handleRequest(id: string, method: string, params: unknown): Promise<void> {
    const spec = (rpcMethods as unknown as Record<string, { input: TSchema } | undefined>)[method];
    if (!spec) {
      this.#error(id, "method-not-found", `unknown method ${method}`);
      return;
    }
    if (!Check(spec.input, params)) {
      const first = Errors(spec.input, params)[0];
      this.#error(id, "invalid-params", first?.message ?? "invalid params");
      return;
    }

    const ctx: RpcCallContext = {
      connectionId: this.#connectionId,
      requestId: id,
      cancelStream: (streamId) => this.cancelStream(streamId),
    };

    const unary = this.#unary.get(method);
    if (unary) {
      try {
        const result = await unary(params, ctx);
        if (!this.#closed) this.#send({ id, result });
      } catch (err) {
        this.#fromThrow(id, method, err);
      }
      return;
    }

    const stream = this.#streams.get(method);
    if (!stream) {
      this.#error(id, "method-not-found", `method ${method} has no handler`);
      return;
    }
    const entry = { cancel: null as (() => void) | null, closed: false };
    this.#active.set(id, entry);
    const emit = (chunk: unknown): void => {
      if (entry.closed || this.#closed) return;
      this.#send({ id, chunk });
    };
    try {
      const cancel = await stream(params, ctx, emit);
      if (entry.closed) cancel();
      else entry.cancel = cancel;
    } catch (err) {
      this.#active.delete(id);
      this.#fromThrow(id, method, err);
    }
  }

  cancelStream(id: string): boolean {
    const entry = this.#active.get(id);
    if (!entry) return false;
    this.#active.delete(id);
    entry.closed = true;
    entry.cancel?.();
    if (!this.#closed) this.#send({ id, end: true });
    return true;
  }

  /** Socket closed: drop every stream without writing to the dead socket. */
  close(): void {
    this.#closed = true;
    for (const [, entry] of this.#active) {
      entry.closed = true;
      entry.cancel?.();
    }
    this.#active.clear();
  }

  #fromThrow(id: string, method: string, err: unknown): void {
    if (err instanceof RpcException) {
      this.#error(id, err.code, err.message, err.data);
      return;
    }
    console.error(`[rpc] ${method} failed`, err);
    this.#error(id, "internal", "internal error");
  }

  #error(id: string, code: string, message: string, data?: unknown): void {
    if (this.#closed) return;
    this.#send({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  }
}
