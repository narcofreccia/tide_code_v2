import {
  applyRecord,
  emptyReadModel,
  type ClientCommand,
  type ModelChunk,
  type ReadModel,
  type RpcOutput,
} from "@tide/contracts";
import type { ConnectionStatus, StreamHandle, TideConnection } from "./connection.ts";

/** The slice of TideConnection the store needs (kept structural for tests). */
export type ModelStoreConnection = Pick<TideConnection, "status" | "on" | "call" | "stream">;

export interface ModelStoreState {
  model: ReadModel;
  status: ConnectionStatus;
  lastError: string | null;
}

export interface ModelStore {
  getState(): ModelStoreState;
  subscribe(listener: () => void): () => void;
  dispatch(command: ClientCommand): Promise<RpcOutput<"orchestration.dispatch">>;
  /** stop following the connection and cancel the live subscription */
  dispose(): void;
}

/**
 * Holds the projected ReadModel and keeps it in sync with `model.subscribe`.
 * On reconnect it resumes from the last applied seq so the server replays only
 * the gap; `applyRecord` makes any overlap a no-op.
 */
export function createModelStore(conn: ModelStoreConnection): ModelStore {
  let state: ModelStoreState = { model: emptyReadModel(), status: conn.status, lastError: null };
  const listeners = new Set<() => void>();
  let sub: StreamHandle | undefined;
  let hasSnapshot = false;
  let disposed = false;

  const emit = (): void => {
    for (const l of [...listeners]) l();
  };
  const patch = (next: Partial<ModelStoreState>): void => {
    state = { ...state, ...next };
    emit();
  };

  const onChunk = (chunk: ModelChunk): void => {
    if (chunk.kind === "snapshot") {
      hasSnapshot = true;
      patch({ model: chunk.model });
    } else {
      patch({ model: applyRecord(state.model, chunk.record) });
    }
  };

  const startSubscription = (): void => {
    if (disposed || sub) return;
    const params = hasSnapshot ? { fromSeq: state.model.seq } : {};
    const handle = conn.stream("model.subscribe", params, onChunk);
    sub = handle;
    handle.done
      .catch((err: unknown) => {
        if (!disposed) patch({ lastError: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        if (sub === handle) sub = undefined;
      });
  };

  const offStatus = conn.on("status", (status) => {
    patch({ status });
    if (status === "open") {
      patch({ lastError: null });
      startSubscription();
    } else {
      sub = undefined; // the connection already settled it; a new one starts on reopen
    }
  });

  if (conn.status === "open") startSubscription();

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispatch(command) {
      try {
        const result = await conn.call("orchestration.dispatch", { command });
        // Applying here is only a latency shortcut; applyRecord's seq guard
        // makes the same records arriving over the subscription a no-op.
        let model = state.model;
        for (const record of result.events) model = applyRecord(model, record);
        if (model !== state.model) patch({ model });
        return result;
      } catch (err) {
        patch({ lastError: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    dispose() {
      disposed = true;
      offStatus();
      sub?.cancel();
      sub = undefined;
      listeners.clear();
    },
  };
}
