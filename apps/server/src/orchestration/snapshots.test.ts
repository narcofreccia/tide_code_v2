import { describe, expect, it, vi } from "vitest";
import { emptyReadModel, replay } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "./engine.ts";
import { playHistory } from "./history.testutil.ts";
import { MODEL_SCHEMA } from "./snapshots.ts";
import { EventStore } from "./store.ts";

async function memoryStore(): Promise<EventStore> {
  return new EventStore(await openDatabase(":memory:"));
}

function bootLog(store: EventStore, options: { compaction?: boolean } = {}): { engine: Engine; lines: string[] } {
  const lines: string[] = [];
  const engine = new Engine({ store, log: (msg) => lines.push(msg), snapshotEvery: 0, ...options });
  return { engine, lines };
}

const count = (store: EventStore, sql: string): number => Number(store.sideTable("").prepare(sql).get()?.["n"]);

describe("read-model snapshots", () => {
  it.each([true, false])("boots from a mid-turn snapshot + tail to the same model a full replay builds (compaction %s)", async (compaction) => {
    const store = await memoryStore();
    const engine = new Engine({ store, snapshotEvery: 0, compaction, log: () => undefined });
    const h = await playHistory(engine, { threads: 3, turnsPerThread: 4, leaveRunning: true, seed: 11 });
    // taken while a turn runs and an approval waits
    const midTurn = engine.getModel();
    expect(midTurn.turns[h.runningTurnId ?? ""]?.status).toBe("running");
    expect(midTurn.threads[h.threadIds[0] ?? ""]?.attention).toBe("approval");
    const snap = engine.snapshot();
    expect(snap?.seq).toBe(midTurn.seq);
    // more history after the snapshot (another project, so the running turn stays as it is)
    await playHistory(engine, { threads: 2, turnsPerThread: 3, seed: 12 });

    const full = replay(emptyReadModel(), store.readAll());
    expect(full).toEqual(engine.getModel());
    const { engine: rebooted, lines } = bootLog(store);
    expect(rebooted.getModel()).toEqual(full);
    expect(lines).toEqual([expect.stringContaining(`replayed ${store.readFrom((snap?.seq ?? 0) + 1).length} events from snapshot at seq ${snap?.seq}`)]);
  });

  it("snapshots of a model at exactly the boundary of a settle replay equally (snapshot right after the run)", async () => {
    const store = await memoryStore();
    const engine = new Engine({ store, snapshotEvery: 0, log: () => undefined });
    await playHistory(engine, { threads: 2, turnsPerThread: 2, seed: 3 });
    engine.snapshot();
    const { engine: rebooted, lines } = bootLog(store);
    expect(rebooted.getModel()).toEqual(engine.getModel());
    expect(lines[0]).toContain("replayed 0 events from snapshot");
  });

  it("ignores a corrupt snapshot with a warning, falling back to the older one or a full replay", async () => {
    const store = await memoryStore();
    const engine = new Engine({ store, snapshotEvery: 0, log: () => undefined });
    await playHistory(engine, { threads: 2, turnsPerThread: 2, seed: 5 });
    const good = engine.snapshot();
    await playHistory(engine, { threads: 1, turnsPerThread: 1, seed: 6 });
    store.snapshots.write(store.lastSeq(), "{not json", 0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { engine: rebooted, lines } = bootLog(store);
      expect(rebooted.getModel()).toEqual(engine.getModel());
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`snapshot at seq ${store.lastSeq()} is unreadable`));
      expect(lines[0]).toContain(`from snapshot at seq ${good?.seq}`);

      // with only garbage left: full replay
      store.sideTable("").exec("DELETE FROM snapshots");
      store.snapshots.write(store.lastSeq(), JSON.stringify({ seq: 1 }), 0);
      const { engine: again, lines: lines2 } = bootLog(store);
      expect(again.getModel()).toEqual(engine.getModel());
      expect(lines2[0]).toContain("from the start");
    } finally {
      warn.mockRestore();
    }
  });

  it("skips snapshots of another model schema", async () => {
    const store = await memoryStore();
    const engine = new Engine({ store, snapshotEvery: 0, log: () => undefined });
    await playHistory(engine, { threads: 1, turnsPerThread: 2, seed: 9 });
    store.snapshots.write(engine.getModel().seq, JSON.stringify({ ...engine.getModel(), threads: {} }), 0, MODEL_SCHEMA + 1);
    const { engine: rebooted, lines } = bootLog(store);
    expect(rebooted.getModel()).toEqual(engine.getModel());
    expect(lines[0]).toContain("from the start");
  });

  it("keeps only the newest two snapshots", async () => {
    const store = await memoryStore();
    const engine = new Engine({ store, snapshotEvery: 0, log: () => undefined });
    for (let i = 0; i < 4; i++) {
      await engine.dispatch({ type: "project.create", title: `p${i}`, rootPath: `/r${i}` });
      engine.snapshot();
    }
    expect(store.sideTable("").prepare("SELECT seq FROM snapshots ORDER BY seq").all()).toEqual([{ seq: 3 }, { seq: 4 }]);
    // nothing new: no duplicate write
    expect(engine.snapshot()).toBeUndefined();
  });

  it("writes one automatically once more than N events were appended, between commands", async () => {
    const store = await memoryStore();
    const engine = new Engine({ store, snapshotEvery: 10, log: () => undefined });
    for (let i = 0; i < 25; i++) await engine.dispatch({ type: "project.create", title: `p${i}`, rootPath: `/r${i}` });
    await engine.drain();
    expect(store.sideTable("").prepare("SELECT seq FROM snapshots ORDER BY seq").all()).toEqual([{ seq: 10 }, { seq: 20 }]);
    // a reboot counts the tail towards the next one
    const rebooted = new Engine({ store, snapshotEvery: 10, log: () => undefined });
    for (let i = 25; i < 30; i++) await rebooted.dispatch({ type: "project.create", title: `p${i}`, rootPath: `/r${i}` });
    await rebooted.drain();
    expect(store.snapshots.latestSeq()).toBe(30);
  });

  it("warns once about event types this server does not know", async () => {
    const store = await memoryStore();
    const engine = new Engine({ store, snapshotEvery: 0, log: () => undefined });
    await engine.dispatch({ type: "project.create", title: "p", rootPath: "/r" });
    const insert = store.sideTable("").prepare("INSERT INTO events (ts, type, aggregate_id, payload) VALUES (1, ?, NULL, ?)");
    for (let i = 0; i < 3; i++) insert.run("future.thing", JSON.stringify({ type: "future.thing", x: i }));
    insert.run("future.other", JSON.stringify({ type: "future.other" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { engine: rebooted } = bootLog(store);
      expect(rebooted.getModel().seq).toBe(5);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/4 events of types this server does not know.*future\.thing×3, future\.other×1/);
    } finally {
      warn.mockRestore();
    }
    expect(count(store, "SELECT COUNT(*) AS n FROM events")).toBe(5);
  });
});

describe("snapshot tag (R18)", () => {
  it("a snapshot is loaded only by the tag that wrote it; null never loads one", async () => {
    const store = await memoryStore();
    const lines: string[] = [];
    const log = (m: string): void => void lines.push(m);
    const a = new Engine({ store, snapshotTag: "1.0.0", log });
    await a.dispatch({ type: "project.create", title: "P", rootPath: "/tmp/p" });
    await a.drain();
    expect(a.snapshot()).toBeDefined();
    const same = new Engine({ store, snapshotTag: "1.0.0", log });
    expect(lines.at(-1)).toContain("from snapshot");
    expect(same.getModel()).toEqual(a.getModel());
    const newer = new Engine({ store, snapshotTag: "1.0.1", log });
    expect(lines.at(-1)).toContain("no snapshot");
    expect(newer.getModel()).toEqual(a.getModel());
    new Engine({ store, snapshotTag: null, log });
    expect(lines.at(-1)).toContain("no snapshot");
  });

  it("a new build re-tags the snapshot at the same seq, so only its first boot replays", async () => {
    const store = await memoryStore();
    const lines: string[] = [];
    const log = (m: string): void => void lines.push(m);
    const old = new Engine({ store, snapshotTag: "1.0.0", log });
    await old.dispatch({ type: "project.create", title: "P", rootPath: "/tmp/p" });
    await old.drain();
    expect(old.snapshot()).toBeDefined();
    const upgraded = new Engine({ store, snapshotTag: "1.0.1", log });
    expect(upgraded.snapshotStale).toBe(true);
    // no new events since the old snapshot: the write must still happen
    expect(upgraded.snapshot()?.seq).toBe(old.getModel().seq);
    expect(upgraded.snapshotStale).toBe(false);
    expect(upgraded.snapshot()).toBeUndefined();
    const next = new Engine({ store, snapshotTag: "1.0.1", log });
    expect(lines.at(-1)).toContain("from snapshot");
    expect(next.snapshotStale).toBe(false);
  });

  it("reports live replay progress in batches when replaying 1,000+ events and matches pure replay", async () => {
    const store = await memoryStore();
    const engine = new Engine({ store, snapshotEvery: 0, compaction: false, log: () => undefined });
    const proj = await engine.dispatch({ type: "project.create", title: "Big", rootPath: "/tmp/big" });
    const projectId = proj.events[0]?.event.type === "project.created" ? proj.events[0].event.project.id : "";
    const created = await engine.dispatch({ type: "thread.create", projectId, provider: "claude" });
    const threadId = created.events[0]?.event.type === "thread.created" ? created.events[0].event.thread.id : "";
    // Seed 1,100 events directly into the store across batch boundary (REPLAY_BATCH_SIZE = 1,000)
    const turn = await engine.dispatch({ type: "turn.request", threadId, text: "go" });
    const turnId = turn.events[0]?.event.type === "turn.requested" ? turn.events[0].event.turn.id : "";
    const batch = [];
    for (let i = 0; i < 1_050; i++) {
      batch.push({ type: "assistant.delta" as const, threadId, turnId, messageId: "m-big", delta: "a", at: i });
    }
    store.append(batch, 100);
    const progress: string[] = [];
    const rebooted = new Engine({ store, snapshotTag: "s5:test", snapshotEvery: 0, log: () => undefined, onBootProgress: (m) => progress.push(m) });
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[0]).toMatch(/^Updating local history… \d+%/);
    expect(progress.at(-1)).toMatch(/90%/);
    const pure = replay(emptyReadModel(), store.readAll());
    expect(rebooted.getModel()).toEqual(pure);
  });
});
