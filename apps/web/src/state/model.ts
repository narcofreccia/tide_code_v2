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
import type { ConnectionStatus, ModelStore } from "@tide/client";

interface ModelState {
  model: ReadModel;
  status: ConnectionStatus;
  lastError: string | null;
  environmentId: string | null;
}

export const useModel = create<ModelState>(() => ({
  model: emptyReadModel(),
  status: "closed",
  lastError: null,
  environmentId: null,
}));

let client: ModelStore | undefined;

/** Mirrors the framework-agnostic client store into Zustand. */
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

export function dispatch(command: ClientCommand): Promise<DispatchResult> {
  if (!client) return Promise.reject(new Error("model store not attached"));
  return client.dispatch(command);
}

export type RpcCaller = <M extends UnaryMethodName>(method: M, params: RpcInput<M>) => Promise<RpcOutput<M>>;

let caller: RpcCaller | undefined;

/** Lets non-command RPC (providers.list, thread.terminalCommand) reach the connection. */
export function setRpcCaller(fn: RpcCaller | undefined): void {
  caller = fn;
}

export function call<M extends UnaryMethodName>(method: M, params: RpcInput<M>): Promise<RpcOutput<M>> {
  if (!caller) return Promise.reject(new Error("connection not attached"));
  return caller(method, params);
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
): StreamControl {
  if (!streamer) return INERT;
  return streamer(method, params, onChunk);
}
