import type { ChildLike, SpawnFn } from "./types.ts";

interface Written {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/**
 * A scripted `codex app-server` for tests: it answers `initialize`/`thread/*`/`turn/*` with
 * canned results and lets the test push notifications and server requests at will. Lives in
 * `src/` (not `test/`) because the session tests inject it through `CodexConfig.spawnImpl`.
 */
export class FakeAppServer implements ChildLike {
  readonly written: Written[] = [];
  readonly args: string[] = [];
  killed = 0;
  model = "gpt-5.6-sol";
  threadId = "thread-1";
  turnId = "turn-1";
  /** methods that should answer with a JSON-RPC error instead of a result */
  failMethods = new Map<string, string>();

  #listeners: ((chunk: unknown) => void)[] = [];
  #exit: ((arg: unknown) => void)[] = [];

  readonly stdin = {
    write: (data: string): void => {
      for (const line of data.split("\n")) {
        if (line.trim() === "") continue;
        const message = JSON.parse(line) as Written;
        this.written.push(message);
        if (message.method !== undefined && message.id !== undefined) this.#answer(message);
      }
    },
  };

  readonly stdout = {
    on: (_event: "data", listener: (chunk: unknown) => void): void => {
      this.#listeners.push(listener);
    },
  };

  readonly stderr = { on: (): void => undefined };

  on(event: "exit" | "error", listener: (arg: unknown) => void): void {
    if (event === "exit") this.#exit.push(listener);
  }

  kill(): void {
    this.killed++;
    for (const listener of this.#exit) listener(0);
  }

  /** Calls written by the driver, oldest first. */
  calls(method: string): Record<string, unknown>[] {
    return this.written.flatMap((message) => (message.method === method ? [message.params ?? {}] : []));
  }

  /** The driver's reply to a server request, by request id. */
  replyTo(id: string | number): Written | undefined {
    return this.written.find((message) => message.id === id && message.method === undefined);
  }

  emit(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    for (const listener of this.#listeners) listener(line);
  }

  notify(method: string, params: unknown): void {
    this.emit({ jsonrpc: "2.0", method, params });
  }

  serverRequest(id: string | number, method: string, params: unknown): void {
    this.emit({ jsonrpc: "2.0", id, method, params });
  }

  #answer(message: Written): void {
    const failure = message.method !== undefined ? this.failMethods.get(message.method) : undefined;
    if (failure !== undefined) {
      this.emit({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: failure } });
      return;
    }
    this.emit({ jsonrpc: "2.0", id: message.id, result: this.#result(message) });
  }

  #result(message: Written): unknown {
    switch (message.method) {
      case "initialize":
        return { userAgent: "fake", codexHome: "/tmp/.codex", platformFamily: "unix", platformOs: "macos" };
      case "thread/start":
      case "thread/resume":
        return { thread: { id: this.threadId, turns: [] }, model: this.model, modelProvider: "openai", cwd: "/tmp/repo" };
      case "turn/start":
        return { turn: { id: this.turnId, items: [], itemsView: "notLoaded", status: "inProgress" } };
      case "account/read":
        return { account: { type: "chatgpt", email: "dev@example.com", planType: "pro" }, requiresOpenaiAuth: false };
      case "model/list":
        return { data: [{ id: this.model, model: this.model, displayName: "GPT-5.6-Sol", hidden: false, isDefault: true }], nextCursor: null };
      default:
        return {};
    }
  }
}

/** A `spawnImpl` that hands out (and records) `FakeAppServer`s. */
export function fakeSpawn(): { spawn: SpawnFn; servers: FakeAppServer[]; last: () => FakeAppServer } {
  const servers: FakeAppServer[] = [];
  const spawn: SpawnFn = (_command, args) => {
    const server = new FakeAppServer();
    server.args.push(...args);
    servers.push(server);
    return server;
  };
  return { spawn, servers, last: () => servers.at(-1)! };
}
