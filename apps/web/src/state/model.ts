import { create } from "zustand";
import {
  emptyReadModel,
  type ClientCommand,
  type ReadModel,
  type RpcInput,
  type RpcOutput,
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
