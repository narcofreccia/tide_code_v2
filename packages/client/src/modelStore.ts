import {
  applyRecord,
  emptyReadModel,
  mergeActivities,
  type Activity,
  type ClientCommand,
  type ModelChunk,
  type ReadModel,
  type RpcOutput,
} from "@tide/contracts";
import type { ConnectionStatus, StreamHandle, TideConnection } from "./connection.ts";
import { onPageHidden, scheduleFrame, type FrameScheduler } from "./frameScheduler.ts";

/** The slice of TideConnection the store needs (kept structural for tests). */
export type ModelStoreConnection = Pick<TideConnection, "status" | "on" | "call" | "stream">;

export interface ModelStoreState {
  model: ReadModel;
  status: ConnectionStatus;
  lastError: string | null;
  /**
   * true once the first `model.subscribe` snapshot has landed (and from then on, across
   * reconnects): before it, an empty model means "no data yet", not "nothing there".
   * Optional so structural test doubles can omit it; absent reads as ready.
   */
  ready?: boolean;
  /**
   * R24: how many snapshots replaced the model. The store subscribes with `scope: "resident"`,
   * so activities fetched with `thread.activities` live only until the next snapshot (first
   * load, or a reconnect past the server's compaction): a change means "fetch them again".
   * Absent on stores that hold the full model (test doubles).
   */
  epoch?: number;
}

export interface ModelStore {
  getState(): ModelStoreState;
  subscribe(listener: () => void): () => void;
  dispatch(command: ClientCommand): Promise<RpcOutput<"orchestration.dispatch">>;
  /**
   * R24: merge a `thread.activities` reply (newer `updatedAt` wins over live upserts).
   * Optional: a store holding the full model (test doubles) has nothing to merge.
   */
  mergeActivities?(activities: readonly Activity[]): void;
  /** R24: forget these activities (pruning a thread the user left); one map copy. */
  dropActivities?(ids: ReadonlySet<string>): void;
  /** stop following the connection and cancel the live subscription */
  dispose(): void;
}

export interface ModelStoreOptions {
  /** when a batch of records is published; default one animation frame (`scheduleFrame`) */
  schedule?: FrameScheduler;
}

/**
 * Holds the projected ReadModel and keeps it in sync with `model.subscribe`.
 * On reconnect it resumes from the last applied seq so the server replays only
 * the gap; `applyRecord` makes any overlap a no-op.
 *
 * Records are applied one by one (`getState()` is always current) but listeners
 * hear about them at most once per frame. Status, errors and command receipts
 * publish at once, taking any pending records with them.
 */
export function createModelStore(conn: ModelStoreConnection, opts: ModelStoreOptions = {}): ModelStore {
  const schedule = opts.schedule ?? scheduleFrame;
  let state: ModelStoreState = { model: emptyReadModel(), status: conn.status, lastError: null, ready: false, epoch: 0 };
  const listeners = new Set<() => void>();
  let sub: StreamHandle | undefined;
  let hasSnapshot = false;
  let disposed = false;
  let publishQueued = false;

  const emit = (): void => {
    publishQueued = false;
    for (const l of [...listeners]) l();
  };
  const flushPending = (): void => {
    if (publishQueued) emit();
  };
  const patch = (next: Partial<ModelStoreState>): void => {
    state = { ...state, ...next };
    emit();
  };
  const setModelBatched = (model: ReadModel, ready = state.ready === true, epoch = state.epoch ?? 0): void => {
    if (model === state.model && ready === state.ready && epoch === state.epoch) return;
    state = { ...state, model, ready, epoch };
    if (publishQueued) return;
    publishQueued = true;
    schedule(flushPending);
  };

  const onChunk = (chunk: ModelChunk): void => {
    if (chunk.kind === "snapshot") {
      hasSnapshot = true;
      // ready rides with the snapshot's own publish: no frame where it is ready but still empty
      setModelBatched(chunk.model, true, (state.epoch ?? 0) + 1);
    } else {
      setModelBatched(applyRecord(state.model, chunk.record));
    }
  };
  const offHidden = onPageHidden(flushPending);

  const startSubscription = (): void => {
    if (disposed || sub) return;
    // R24: resident scope — activities of settled turns are fetched per thread (`thread.activities`)
    const params = hasSnapshot ? { fromSeq: state.model.seq, scope: "resident" as const } : { scope: "resident" as const };
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
        // receipts are visible at once, along with any records still waiting for a frame
        if (model !== state.model) patch({ model });
        else flushPending();
        return result;
      } catch (err) {
        patch({ lastError: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    mergeActivities(activities) {
      const next = mergeActivities(state.model.activities, activities);
      if (next !== state.model.activities) setModelBatched({ ...state.model, activities: next });
    },
    dropActivities(ids) {
      const held = state.model.activities;
      let next: ReadModel["activities"] | undefined;
      for (const id of ids) {
        if (held[id] === undefined) continue;
        next ??= { ...held };
        delete next[id];
      }
      if (next !== undefined) setModelBatched({ ...state.model, activities: next });
    },
    dispose() {
      disposed = true;
      publishQueued = false;
      offHidden();
      offStatus();
      sub?.cancel();
      sub = undefined;
      listeners.clear();
    },
  };
}
