import { describe, expect, it } from "vitest";
import {
  emptyReadModel,
  residentModel,
  threadActivitiesOf,
  type Activity,
  type ActivityOf,
  type ModelChunk,
  type ReadModel,
  type Thread,
} from "@tide/contracts";
import type { ConnectionStatus, StreamHandle } from "./connection.ts";
import { createModelStore, type ModelStore, type ModelStoreConnection } from "./modelStore.ts";
import { createThreadActivities, windowStartIndex, type ThreadActivitiesHost } from "./threadActivities.ts";
import { selectThreadTurns } from "./selectors.ts";

const thread = (id: string): Thread => ({
  id,
  projectId: "p1",
  title: id,
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
});

const tool = (id: string, threadId: string, turnId: string, patch: Partial<ActivityOf<"tool">> = {}): ActivityOf<"tool"> => ({
  id,
  threadId,
  turnId,
  createdAt: 1,
  updatedAt: 1,
  kind: "tool",
  toolUseId: `use-${id}`,
  toolName: "Read",
  input: {},
  status: "ok",
  ...patch,
});

/** `threads` threads of `turns` settled turns, one tool row per turn. */
function fullModel(threads: string[], turns: number): ReadModel {
  const m = emptyReadModel();
  m.seq = 10;
  for (const t of threads) {
    m.threads[t] = thread(t);
    m.threadTimeline[t] = [];
    for (let i = 0; i < turns; i++) {
      const turnId = `${t}-u${String(i).padStart(2, "0")}`;
      m.turns[turnId] = { id: turnId, threadId: t, status: "completed", requestedAt: i + 1, settledAt: i + 2 };
      const a = tool(`${turnId}-a`, t, turnId);
      m.activities[a.id] = a;
      m.threadTimeline[t]!.push({ kind: "activity", id: a.id });
    }
  }
  return m;
}

interface Pending {
  threadId: string;
  turnIds: readonly string[];
  resolve: (a: readonly Activity[]) => void;
  reject: (e: unknown) => void;
}

function setup(full: ReadModel, keep?: number) {
  let status: ConnectionStatus = "closed";
  const statusListeners = new Set<(s: ConnectionStatus) => void>();
  const pushes: ((c: ModelChunk) => void)[] = [];
  const conn = {
    get status() {
      return status;
    },
    on: (_e: string, cb: (s: ConnectionStatus) => void) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    call: async () => ({ seq: 0, events: [] }),
    stream: (_m: string, _p: unknown, onChunk: (c: ModelChunk) => void): StreamHandle => {
      pushes.push(onChunk);
      return { id: "s", cancel: () => undefined, done: new Promise<void>(() => undefined) };
    },
  } as unknown as ModelStoreConnection;
  const store: ModelStore = createModelStore(conn, { schedule: (cb) => cb() });
  const setStatus = (s: ConnectionStatus): void => {
    status = s;
    for (const l of statusListeners) l(s);
  };
  const pending: Pending[] = [];
  const host: ThreadActivitiesHost = {
    getModel: () => store.getState().model,
    epoch: () => store.getState().epoch,
    fetch: (threadId, turnIds) => new Promise((resolve, reject) => pending.push({ threadId, turnIds, resolve, reject })),
    merge: (_t, activities) => store.mergeActivities?.(activities),
    drop: (ids) => store.dropActivities?.(ids),
    subscribe: (l) => store.subscribe(l),
  };
  const tracker = createThreadActivities(host, keep === undefined ? {} : { keep });
  const snapshot = (model: ReadModel): void => pushes.at(-1)?.({ kind: "snapshot", model: residentModel(model) });
  /** answers the oldest pending fetch from `full` */
  const answer = async (): Promise<Pending> => {
    const p = pending.shift();
    if (!p) throw new Error("no pending fetch");
    p.resolve(threadActivitiesOf(full, p.threadId, p.turnIds));
    await Promise.resolve();
    await Promise.resolve();
    return p;
  };
  const held = (threadId: string): string[] => Object.values(store.getState().model.activities).filter((a) => a.threadId === threadId).map((a) => a.turnId);
  return { store, tracker, setStatus, snapshot, pending, answer, held };
}

describe("thread activity windows (R24)", () => {
  it("fetches the newest 15 turns on open, once, and extends by 15 with loadEarlier", async () => {
    const full = fullModel(["t1"], 40);
    const h = setup(full);
    h.setStatus("open");
    h.snapshot(full);
    expect(h.held("t1")).toEqual([]);

    h.tracker.open("t1");
    h.tracker.ensureWindow("t1"); // in flight: deduped
    expect(h.pending).toHaveLength(1);
    expect(h.pending[0]?.turnIds).toHaveLength(15);
    expect(h.tracker.windowOf("t1")).toMatchObject({ anchor: "t1-u25", loading: true });
    await h.answer();
    expect(h.tracker.windowOf("t1").loading).toBe(false);
    expect(h.held("t1")).toHaveLength(15);
    const turns = selectThreadTurns(h.store.getState().model, "t1");
    expect(windowStartIndex(h.tracker.windowOf("t1"), turns)).toBe(25);

    h.tracker.ensureWindow("t1");
    expect(h.pending).toHaveLength(0);

    h.tracker.loadEarlier("t1");
    h.tracker.loadEarlier("t1"); // deduped
    expect(h.pending).toHaveLength(1);
    expect(h.pending[0]?.turnIds[0]).toBe("t1-u10");
    // the window grows when the reply lands, not before
    expect(windowStartIndex(h.tracker.windowOf("t1"), turns)).toBe(25);
    await h.answer();
    expect(windowStartIndex(h.tracker.windowOf("t1"), turns)).toBe(10);

    h.tracker.loadEarlier("t1");
    await h.answer();
    expect(h.tracker.windowOf("t1").anchor).toBeNull();
    expect(h.held("t1")).toHaveLength(40);
    h.tracker.loadEarlier("t1");
    expect(h.pending).toHaveLength(0);
  });

  it("keeps a newer live upsert over an older fetched copy", async () => {
    const full = fullModel(["t1"], 3);
    const h = setup(full);
    h.setStatus("open");
    h.snapshot(full);
    h.tracker.open("t1");
    const live = tool("t1-u02-a", "t1", "t1-u02", { updatedAt: 99, status: "error" });
    h.store.mergeActivities?.([live]);
    await h.answer();
    expect(h.store.getState().model.activities["t1-u02-a"]).toMatchObject({ updatedAt: 99, status: "error" });
    expect(h.held("t1")).toHaveLength(3);
  });

  it("exposes a failure and retries it", async () => {
    const full = fullModel(["t1"], 20);
    const h = setup(full);
    h.setStatus("open");
    h.snapshot(full);
    h.tracker.open("t1");
    h.pending.shift()?.reject(new Error("boom"));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.tracker.windowOf("t1")).toMatchObject({ loading: false, error: "boom" });
    h.tracker.retry("t1");
    expect(h.tracker.windowOf("t1").error).toBeUndefined();
    await h.answer();
    expect(h.held("t1")).toHaveLength(15);

    h.tracker.loadEarlier("t1");
    h.pending.shift()?.reject(new Error("again"));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.tracker.windowOf("t1")).toMatchObject({ loadingEarlier: false, error: "again" });
    h.tracker.retry("t1");
    expect(h.pending[0]?.turnIds).toHaveLength(5);
  });

  it("waits for the first snapshot when opened before it", async () => {
    const full = fullModel(["t1"], 3);
    const h = setup(full);
    h.setStatus("open");
    h.tracker.open("t1");
    expect(h.pending).toHaveLength(0);
    h.snapshot(full);
    expect(h.pending).toHaveLength(1);
    await h.answer();
    expect(h.held("t1")).toHaveLength(3);
    expect(h.tracker.windowOf("t1").anchor).toBeNull();
  });

  it("prunes threads that fall out of the LRU, keeping resident activities", async () => {
    const full = fullModel(["a", "b", "c"], 3);
    // b has a pending approval in a settled turn: resident, never pruned
    full.activities["b-ask"] = {
      id: "b-ask",
      threadId: "b",
      turnId: "b-u00",
      createdAt: 1,
      updatedAt: 1,
      kind: "approval",
      requestId: "r",
      toolName: "Edit",
      input: {},
      status: "pending",
    };
    full.threadTimeline["b"]!.push({ kind: "activity", id: "b-ask" });
    const h = setup(full, 1);
    h.setStatus("open");
    h.snapshot(full);
    expect(h.held("b")).toEqual(["b-u00"]);

    const closeA = h.tracker.open("a");
    await h.answer();
    closeA();
    const closeB = h.tracker.open("b");
    await h.answer();
    closeB();
    // a was pruned when b opened (keep = 1)
    expect(h.held("a")).toEqual([]);
    expect(h.held("b")).toHaveLength(4);

    h.tracker.open("c");
    await h.answer();
    expect(h.held("b")).toEqual(["b-u00"]);
    expect(h.store.getState().model.activities["b-ask"]).toBeDefined();
    expect(h.held("c")).toHaveLength(3);
    // a pruned thread starts over
    expect(h.tracker.windowOf("b").anchor).toBeUndefined();
  });

  it("never prunes a thread still on screen", async () => {
    const full = fullModel(["a", "b"], 2);
    const h = setup(full, 0);
    h.setStatus("open");
    h.snapshot(full);
    h.tracker.open("a");
    await h.answer();
    h.tracker.open("b");
    await h.answer();
    expect(h.held("a")).toHaveLength(2);
    expect(h.held("b")).toHaveLength(2);
  });

  it("re-ensures open threads after a snapshot replaced the model", async () => {
    const full = fullModel(["t1"], 20);
    const h = setup(full);
    h.setStatus("open");
    h.snapshot(full);
    h.tracker.open("t1");
    await h.answer();
    h.tracker.loadEarlier("t1");
    await h.answer();
    expect(h.held("t1")).toHaveLength(20);

    // reconnect with a compaction gap: a fresh resident snapshot
    h.setStatus("reconnecting");
    h.setStatus("open");
    h.snapshot(full);
    expect(h.held("t1")).toEqual([]);
    expect(h.tracker.windowOf("t1")).toMatchObject({ anchor: "t1-u05", loading: true });
    expect(h.pending).toHaveLength(1);
    await h.answer();
    expect(h.held("t1")).toHaveLength(15);
  });

  it("drops a reply that lands after a snapshot reset", async () => {
    const full = fullModel(["t1"], 3);
    const h = setup(full);
    h.setStatus("open");
    h.snapshot(full);
    h.tracker.open("t1");
    const stale = h.pending.shift();
    h.snapshot(full);
    stale?.resolve(threadActivitiesOf(full, "t1", stale.turnIds));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.tracker.windowOf("t1").loading).toBe(true);
    await h.answer();
    expect(h.tracker.windowOf("t1").loading).toBe(false);
  });

  it("treats a full store as one window over every turn", () => {
    const full = fullModel(["t1"], 30);
    const host: ThreadActivitiesHost = {
      getModel: () => full,
      epoch: () => undefined,
      fetch: () => Promise.reject(new Error("no fetch on a full store")),
      merge: () => undefined,
      drop: () => undefined,
      subscribe: () => () => undefined,
    };
    const tracker = createThreadActivities(host);
    expect(tracker.windowOf("t1").anchor).toBeNull();
    tracker.open("t1");
    expect(windowStartIndex(tracker.windowOf("t1"), selectThreadTurns(full, "t1"))).toBe(0);
  });
});
