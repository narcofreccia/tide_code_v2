/**
 * Newline-delimited JSON-RPC 2.0 over a pair of byte streams — the framing/correlation
 * half of the app-server transport, with no knowledge of Codex itself so it can be driven
 * by a scripted fake child in tests.
 */

export type RequestId = string | number;

export interface JsonRpcHandlers {
  /** server -> client notification */
  onNotification: (method: string, params: unknown) => void;
  /** server -> client request; the handler MUST eventually call `respond`/`respondError` */
  onRequest: (method: string, params: unknown, id: RequestId) => void;
  /** transport-level problems (unparsable lines, unexpected ids) */
  onLog?: (message: string) => void;
}

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Envelope {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class JsonRpcConnection {
  #write: (line: string) => void;
  #handlers: JsonRpcHandlers;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<string, PendingCall>();
  #closed = false;

  constructor(write: (line: string) => void, handlers: JsonRpcHandlers) {
    this.#write = write;
    this.#handlers = handlers;
  }

  /** Feeds raw stdout bytes; complete lines are dispatched, partials buffered. */
  ingest(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const index = this.#buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line !== "") this.#dispatch(line);
    }
  }

  #dispatch(line: string): void {
    let message: Envelope;
    try {
      message = JSON.parse(line) as Envelope;
    } catch {
      this.#handlers.onLog?.(`unparsable line: ${line.slice(0, 200)}`);
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      this.#handlers.onRequest(message.method, message.params, message.id);
      return;
    }
    if (message.method !== undefined) {
      this.#handlers.onNotification(message.method, message.params);
      return;
    }
    if (message.id === undefined) {
      this.#handlers.onLog?.(`response without id: ${line.slice(0, 200)}`);
      return;
    }
    const key = String(message.id);
    const pending = this.#pending.get(key);
    if (!pending) {
      this.#handlers.onLog?.(`response for unknown id ${key}`);
      return;
    }
    this.#pending.delete(key);
    if (message.error) pending.reject(new JsonRpcError(message.error.code ?? -1, message.error.message ?? "codex error", message.error.data));
    else pending.resolve(message.result);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("codex app-server connection is closed"));
    const id = this.#nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(String(id), { resolve, reject });
    });
    this.#send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return promise as Promise<T>;
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: RequestId, result: unknown): void {
    this.#send({ jsonrpc: "2.0", id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.#send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** Fails every in-flight call; used when the child exits or the session closes. */
  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const call of pending) call.reject(new Error(reason));
  }

  #send(message: unknown): void {
    if (this.#closed) return;
    this.#write(`${JSON.stringify(message)}\n`);
  }
}
