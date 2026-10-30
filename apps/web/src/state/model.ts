import { create } from "zustand";
import {
  emptyReadModel,
  type ClientCommand,
  type ReadModel,
  type RpcChunk,
  type RpcInput,
  type RpcOutput,
  type StreamMethodName,
  type UnaryMethodName,
} from "@tide/contracts";
import { emptyOwnership, type ConnectionStatus, type ModelStore, type Ownership } from "@tide/client";

interface ModelState {
  /** R9: the union of every connected environment's read model */
  model: ReadModel;
  /** R9: project / thread → environment id (live models + what was persisted) */
  ownership: Ownership;
  /** the primary environment's connection */
  status: ConnectionStatus;
  lastError: string | null;
  /** the primary environment's id */
  environmentId: string | null;
}

export const useModel = create<ModelState>(() => ({
  model: emptyReadModel(),
  ownership: emptyOwnership(),
  status: "closed",
  lastError: null,
  environmentId: null,
}));

/** R9: where a call / command / stream goes. Explicit `envId` wins over ownership and the primary. */
export interface RouteOptions {
  envId?: string;
}

let client: ModelStore | undefined;

/**
 * Mirrors one framework-agnostic client store into Zustand. The single-environment
 * seam (tests, `attachFakeStore`); the environment manager writes the merged model directly.
 */
export function attachModelStore(store: ModelStore): () => void {
  client = store;
  const sync = (): void => {
    const { model, status, lastError } = store.getState();
    useModel.setState({ model, status, lastError });
  };
  sync();
  const unsubscribe = store.subscribe(sync);
  return () => {
    unsubscribe();
    if (client === store) client = undefined;
  };
}

export function setEnvironmentId(environmentId: string | null): void {
  useModel.setState({ environmentId });
}

export type DispatchResult = RpcOutput<"orchestration.dispatch">;

export type Dispatcher = (command: ClientCommand, opts?: RouteOptions) => Promise<DispatchResult>;

let dispatcher: Dispatcher | undefined;

/** R9: the environment manager's routed dispatch; wins over an attached single store. */
export function setDispatcher(fn: Dispatcher | undefined): void {
  dispatcher = fn;
}

export function dispatch(command: ClientCommand, opts?: RouteOptions): Promise<DispatchResult> {
  if (dispatcher) return dispatcher(command, opts);
  if (!client) return Promise.reject(new Error("model store not attached"));
  return client.dispatch(command);
}

export type RpcCaller = <M extends UnaryMethodName>(
  method: M,
  params: RpcInput<M>,
  opts?: RouteOptions,
) => Promise<RpcOutput<M>>;

let caller: RpcCaller | undefined;

/** Lets non-command RPC (providers.list, thread.terminalCommand) reach the connection(s). */
export function setRpcCaller(fn: RpcCaller | undefined): void {
  caller = fn;
}

export function call<M extends UnaryMethodName>(method: M, params: RpcInput<M>, opts?: RouteOptions): Promise<RpcOutput<M>> {
  if (!caller) return Promise.reject(new Error("connection not attached"));
  return opts === undefined ? caller(method, params) : caller(method, params, opts);
}

// ---- streaming RPC (fs.watch, pty.attach) ----

export interface StreamControl {
  cancel: () => void;
  /** resolves when the server ends the stream, rejects on error/disconnect */
  done: Promise<void>;
}

export type RpcStreamer = <M extends StreamMethodName>(
  method: M,
  params: RpcInput<M>,
  onChunk: (chunk: RpcChunk<M>) => void,
  opts?: RouteOptions,
) => StreamControl;

let streamer: RpcStreamer | undefined;

/** Parallel to `setRpcCaller`, for the stream methods (`fs.watch`, `pty.attach`). */
export function setRpcStreamer(fn: RpcStreamer | undefined): void {
  streamer = fn;
}

const INERT: StreamControl = { cancel: () => undefined, done: Promise.resolve() };

/**
 * Subscribes to a stream method. With no connection attached the handle is inert
 * rather than throwing: watchers mount before the socket is up and must not crash.
 */
export function stream<M extends StreamMethodName>(
  method: M,
  params: RpcInput<M>,
  onChunk: (chunk: RpcChunk<M>) => void,
  opts?: RouteOptions,
): StreamControl {
  if (!streamer) return INERT;
  return opts === undefined ? streamer(method, params, onChunk) : streamer(method, params, onChunk, opts);
}
