import { emptyReadModel, type ClientCommand, type ReadModel, type RpcChunk, type RpcInput, type RpcOutput, type StreamMethodName, type UnaryMethodName } from "@tide/contracts";
import type { EnvConnectionSnapshot, EnvironmentConnectionOptions, ModelStore, ModelStoreState, StreamHandle } from "@tide/client";
import { setConnectionFactory, setFrameScheduler, type EnvConnectionLike } from "./envManager.ts";
import { defaultUserSettings } from "./serverSettings.ts";

/** Test double for EnvironmentConnection: no sockets, the test drives snapshots and models. */
export class FakeEnvConnection implements EnvConnectionLike {
  readonly opts: EnvironmentConnectionOptions;
  readonly calls: { method: string; params: unknown }[] = [];
  readonly streams: { method: string; params: unknown }[] = [];
  readonly dispatched: ClientCommand[] = [];
  readonly tokens: (string | undefined)[] = [];
  handlers: Record<string, (params: unknown) => unknown> = {
    "providers.list": () => [],
    "settings.get": () => defaultUserSettings(),
  };
  started = false;
  stopped = false;
  probed = 0;
  routes: EnvironmentConnectionOptions["routes"];
  snapshot: EnvConnectionSnapshot = { state: "connecting" };
  readonly store: ModelStore;
  private state: ModelStoreState = { model: emptyReadModel(), status: "connecting", lastError: null };
  private readonly storeListeners = new Set<() => void>();
  private readonly listeners = new Set<(s: EnvConnectionSnapshot) => void>();

  constructor(opts: EnvironmentConnectionOptions) {
    this.opts = opts;
    this.routes = opts.routes;
    this.store = {
      getState: () => this.state,
      subscribe: (l) => {
        this.storeListeners.add(l);
        return () => this.storeListeners.delete(l);
      },
      dispatch: async (command) => {
        this.dispatched.push(command);
        return { seq: 0, events: [] };
      },
      dispose: () => undefined,
    };
  }

  setModel(model: ReadModel): void {
    this.state = { ...this.state, model };
    for (const l of [...this.storeListeners]) l();
  }

  emit(patch: Partial<EnvConnectionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of [...this.listeners]) l(this.snapshot);
  }

  onChange(cb: (s: EnvConnectionSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  setToken(token: string | undefined): void {
    this.tokens.push(token);
  }
  setRoutes(routes: EnvironmentConnectionOptions["routes"]): void {
    this.routes = routes;
  }
  probe(): void {
    this.probed += 1;
  }

  // prototype methods on purpose (like the real EnvironmentConnection): a caller that detaches
  // `conn.call` loses `this` and must fail here as it did in production (R9 live check)
  call<M extends UnaryMethodName>(method: M, params: RpcInput<M>): Promise<RpcOutput<M>> {
    this.calls.push({ method, params });
    const handler = this.handlers[method];
    return (handler ? Promise.resolve(handler(params)) : Promise.reject(new Error(`unmocked ${method}`))) as Promise<RpcOutput<M>>;
  }

  stream<M extends StreamMethodName>(method: M, params: RpcInput<M>, _onChunk: (chunk: RpcChunk<M>) => void): StreamHandle {
    this.streams.push({ method, params });
    return { id: `s${this.streams.length}`, cancel: () => undefined, done: new Promise<void>(() => undefined) };
  }
}

/**
 * Routes every EnvironmentConnection the manager creates to a FakeEnvConnection, and
 * merges on a microtask instead of an animation frame (`flushMicrotasks` settles it).
 */
export function installFakeConnections(): { conns: FakeEnvConnection[]; byId: (id: string) => FakeEnvConnection } {
  setFrameScheduler(queueMicrotask);
  const conns: FakeEnvConnection[] = [];
  setConnectionFactory((opts) => {
    const conn = new FakeEnvConnection(opts);
    conns.push(conn);
    return conn;
  });
  return {
    conns,
    byId: (id) => {
      const conn = [...conns].reverse().find((c) => c.opts.id === id && !c.stopped);
      if (!conn) throw new Error(`no connection for ${id}`);
      return conn;
    },
  };
}

export const flushMicrotasks = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));
