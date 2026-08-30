import { describe, expect, it, vi } from "vitest";
import { createModelStore, type ModelStoreConnection } from "./modelStore.ts";
import type { ConnectionStatus, StreamHandle } from "./connection.ts";
import { emptyReadModel, type EventRecord, type ModelChunk, type ReadModel } from "@tide/contracts";

interface Harness {
  conn: ModelStoreConnection;
  setStatus: (s: ConnectionStatus) => void;
  streamCalls: Array<{ params: unknown; push: (c: ModelChunk) => void }>;
  dispatchResult: { seq: number; events: EventRecord[] };
  calls: Array<{ method: string; params: unknown }>;
}

function harness(): Harness {
  const statusListeners = new Set<(s: ConnectionStatus) => void>();
  const h: Harness = {
    streamCalls: [],
    calls: [],
    dispatchResult: { seq: 0, events: [] },
    setStatus: (s) => {
      status = s;
      for (const l of statusListeners) l(s);
    },
    conn: undefined as unknown as ModelStoreConnection,
  };
  let status: ConnectionStatus = "closed";
  h.conn = {
    get status() {
      return status;
    },
    on(_event, cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    call: (async (method: string, params: unknown) => {
      h.calls.push({ method, params });
      return h.dispatchResult;
    }) as ModelStoreConnection["call"],
    stream: ((_method: string, params: unknown, onChunk: (c: ModelChunk) => void): StreamHandle => {
      h.streamCalls.push({ params, push: onChunk });
      return { id: `s${h.streamCalls.length}`, cancel: () => undefined, done: new Promise<void>(() => undefined) };
    }) as ModelStoreConnection["stream"],
  } as ModelStoreConnection;
  return h;
}

const snapshot = (model: ReadModel): ModelChunk => ({ kind: "snapshot", model });
const projectCreated = (seq: number, id: string): ModelChunk => ({
  kind: "event",
  record: {
    seq,
    ts: seq,
    event: { type: "project.created", project: { id, title: id, rootPath: `/${id}`, createdAt: seq, updatedAt: seq } },
  },
});

describe("createModelStore", () => {
  it("subscribes on open and applies snapshot then events", () => {
    const h = harness();
    const store = createModelStore(h.conn);
    const listener = vi.fn();
    store.subscribe(listener);

    h.setStatus("open");
    expect(h.streamCalls).toHaveLength(1);
    expect(h.streamCalls[0]?.params).toEqual({});

    h.streamCalls[0]?.push(snapshot({ ...emptyReadModel(), seq: 5 }));
    h.streamCalls[0]?.push(projectCreated(6, "p1"));

    const { model, status } = store.getState();
    expect(status).toBe("open");
    expect(model.seq).toBe(6);
    expect(model.projects["p1"]?.title).toBe("p1");
    expect(listener).toHaveBeenCalled();
  });

  it("ignores records at or below the applied seq", () => {
    const h = harness();
    const store = createModelStore(h.conn);
    h.setStatus("open");
    h.streamCalls[0]?.push(snapshot({ ...emptyReadModel(), seq: 5 }));
    h.streamCalls[0]?.push(projectCreated(5, "stale"));
    expect(store.getState().model.projects["stale"]).toBeUndefined();
  });

  it("resumes from the last seq after a reconnect", () => {
    const h = harness();
    const store = createModelStore(h.conn);
    h.setStatus("open");
    h.streamCalls[0]?.push(snapshot({ ...emptyReadModel(), seq: 5 }));
    h.streamCalls[0]?.push(projectCreated(6, "p1"));

    h.setStatus("reconnecting");
    h.setStatus("open");

    expect(h.streamCalls).toHaveLength(2);
    expect(h.streamCalls[1]?.params).toEqual({ fromSeq: 6 });

    h.streamCalls[1]?.push(projectCreated(7, "p2"));
    expect(store.getState().model.seq).toBe(7);
  });

  it("dispatch calls orchestration.dispatch and applies returned events once", async () => {
    const h = harness();
    const store = createModelStore(h.conn);
    h.setStatus("open");
    h.streamCalls[0]?.push(snapshot(emptyReadModel()));

    const record = (projectCreated(1, "p1") as { kind: "event"; record: EventRecord }).record;
    h.dispatchResult = { seq: 1, events: [record] };

    await store.dispatch({ type: "project.create", title: "p1", rootPath: "/p1" });
    expect(h.calls[0]).toEqual({
      method: "orchestration.dispatch",
      params: { command: { type: "project.create", title: "p1", rootPath: "/p1" } },
    });
    expect(store.getState().model.seq).toBe(1);

    // same record arriving over the subscription must not double-apply
    h.streamCalls[0]?.push({ kind: "event", record });
    expect(store.getState().model.seq).toBe(1);
    expect(Object.keys(store.getState().model.projects)).toEqual(["p1"]);
  });
});
