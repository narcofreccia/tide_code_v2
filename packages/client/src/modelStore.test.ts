import { describe, expect, it, vi } from "vitest";
import { createModelStore, type ModelStoreConnection } from "./modelStore.ts";
import type { ConnectionStatus, StreamHandle } from "./connection.ts";
import { emptyReadModel, type ActivityOf, type EventRecord, type ModelChunk, type ReadModel } from "@tide/contracts";

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
    expect(h.streamCalls[0]?.params).toEqual({ scope: "resident" });

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
    expect(h.streamCalls[1]?.params).toEqual({ fromSeq: 6, scope: "resident" });

    h.streamCalls[1]?.push(projectCreated(7, "p2"));
    expect(store.getState().model.seq).toBe(7);
  });

  it("is not ready until the first snapshot, and stays ready across a reconnect", () => {
    const h = harness();
    const store = createModelStore(h.conn);
    expect(store.getState().ready).toBe(false);
    h.setStatus("open");
    expect(store.getState().ready).toBe(false);
    // an empty snapshot is still an answer: "nothing there", not "nothing yet"
    h.streamCalls[0]?.push(snapshot(emptyReadModel()));
    expect(store.getState().ready).toBe(true);
    h.setStatus("reconnecting");
    expect(store.getState().ready).toBe(true);
    h.setStatus("open");
    expect(store.getState().ready).toBe(true);
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

const tool = (id: string, updatedAt: number, status: "ok" | "running" = "ok"): ActivityOf<"tool"> => ({
  id,
  threadId: "t1",
  turnId: "u1",
  createdAt: 1,
  updatedAt,
  kind: "tool",
  toolUseId: `use-${id}`,
  toolName: "Read",
  input: {},
  status,
});

describe("createModelStore resident scope (R24)", () => {
  it("counts snapshots in epoch: a fresh snapshot means fetched activities are gone", () => {
    const h = harness();
    const store = createModelStore(h.conn, { schedule: (cb) => cb() });
    expect(store.getState().epoch).toBe(0);
    h.setStatus("open");
    h.streamCalls[0]?.push(snapshot({ ...emptyReadModel(), seq: 5 }));
    expect(store.getState().epoch).toBe(1);
    h.streamCalls[0]?.push(projectCreated(6, "p1"));
    expect(store.getState().epoch).toBe(1);
    // reconnect past compaction: the server answers fromSeq with a snapshot
    h.setStatus("reconnecting");
    h.setStatus("open");
    h.streamCalls[1]?.push(snapshot({ ...emptyReadModel(), seq: 9 }));
    expect(store.getState().epoch).toBe(2);
  });

  it("merges fetched activities (newer updatedAt wins) and publishes", () => {
    const h = harness();
    const store = createModelStore(h.conn, { schedule: (cb) => cb() });
    h.setStatus("open");
    h.streamCalls[0]?.push(snapshot({ ...emptyReadModel(), seq: 1, activities: { a: tool("a", 5, "running") } }));
    const listener = vi.fn();
    store.subscribe(listener);
    store.mergeActivities?.([tool("a", 3), tool("b", 2)]);
    const held = store.getState().model.activities;
    expect(held["a"]).toMatchObject({ updatedAt: 5, status: "running" });
    expect(held["b"]?.updatedAt).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    // nothing new: same map, no publish
    store.mergeActivities?.([tool("b", 2)]);
    expect(store.getState().model.activities).toBe(held);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("drops activities in one copy and ignores ids it does not hold", () => {
    const h = harness();
    const store = createModelStore(h.conn, { schedule: (cb) => cb() });
    h.setStatus("open");
    h.streamCalls[0]?.push(snapshot({ ...emptyReadModel(), seq: 1, activities: { a: tool("a", 1), b: tool("b", 1) } }));
    const before = store.getState().model.activities;
    store.dropActivities?.(new Set(["zzz"]));
    expect(store.getState().model.activities).toBe(before);
    store.dropActivities?.(new Set(["a", "zzz"]));
    expect(Object.keys(store.getState().model.activities)).toEqual(["b"]);
    expect(before["a"]).toBeDefined();
  });
});

describe("createModelStore frame batching", () => {
  /** A hand-stepped frame clock: `frame()` runs what was scheduled since the last one. */
  function fakeFrames(): { schedule: (cb: () => void) => void; frame: () => void; pending: () => number } {
    let queue: (() => void)[] = [];
    return {
      schedule: (cb) => {
        queue.push(cb);
      },
      frame: () => {
        const run = queue;
        queue = [];
        for (const cb of run) cb();
      },
      pending: () => queue.length,
    };
  }

  it("publishes ten records in one frame once, with the last model", () => {
    const h = harness();
    const frames = fakeFrames();
    const store = createModelStore(h.conn, { schedule: frames.schedule });
    h.setStatus("open");
    h.streamCalls[0]?.push(snapshot({ ...emptyReadModel(), seq: 0 }));
    frames.frame();

    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getState().model.seq));
    for (let seq = 1; seq <= 10; seq++) h.streamCalls[0]?.push(projectCreated(seq, `p${seq}`));
    // applied per record, published not yet
    expect(store.getState().model.seq).toBe(10);
    expect(seen).toEqual([]);
    expect(frames.pending()).toBe(1);

    frames.frame();
    expect(seen).toEqual([10]);
    expect(Object.keys(store.getState().model.projects)).toHaveLength(10);
    frames.frame();
    expect(seen).toEqual([10]);
  });

  it("ready is published in the same frame as the snapshot it came with", () => {
    const h = harness();
    const frames = fakeFrames();
    const store = createModelStore(h.conn, { schedule: frames.schedule });
    h.setStatus("open");
    const seen: [boolean | undefined, number][] = [];
    store.subscribe(() => seen.push([store.getState().ready, store.getState().model.seq]));
    h.streamCalls[0]?.push(snapshot({ ...emptyReadModel(), seq: 3 }));
    expect(seen).toEqual([]);
    frames.frame();
    expect(seen).toEqual([[true, 3]]);
  });

  it("a dispatch receipt publishes at once, taking pending records along", async () => {
    const h = harness();
    const frames = fakeFrames();
    const store = createModelStore(h.conn, { schedule: frames.schedule });
    h.setStatus("open");
    h.streamCalls[0]?.push(snapshot(emptyReadModel()));
    frames.frame();
    const listener = vi.fn();
    store.subscribe(listener);

    h.streamCalls[0]?.push(projectCreated(1, "streamed"));
    const record = (projectCreated(2, "commanded") as { kind: "event"; record: EventRecord }).record;
    h.dispatchResult = { seq: 2, events: [record] };
    await store.dispatch({ type: "project.create", title: "commanded", rootPath: "/c" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(Object.keys(store.getState().model.projects).sort()).toEqual(["commanded", "streamed"]);
    // the frame already queued finds nothing left to publish
    frames.frame();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a receipt with no new records still flushes what streamed in", async () => {
    const h = harness();
    const frames = fakeFrames();
    const store = createModelStore(h.conn, { schedule: frames.schedule });
    h.setStatus("open");
    h.streamCalls[0]?.push(snapshot(emptyReadModel()));
    frames.frame();
    const listener = vi.fn();
    store.subscribe(listener);
    h.streamCalls[0]?.push(projectCreated(1, "p1"));
    h.dispatchResult = { seq: 1, events: [] };
    await store.dispatch({ type: "project.create", title: "x", rootPath: "/x" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("status changes publish immediately", () => {
    const h = harness();
    const frames = fakeFrames();
    const store = createModelStore(h.conn, { schedule: frames.schedule });
    const listener = vi.fn();
    store.subscribe(listener);
    h.setStatus("open");
    expect(listener).toHaveBeenCalled();
    expect(store.getState().status).toBe("open");
  });
});
