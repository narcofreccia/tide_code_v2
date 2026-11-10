import { describe, expect, it } from "vitest";
import { applyRecord, emptyReadModel, replay, type DomainEvent, type EventRecord, type ReadModel } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { planCompaction } from "./compaction.ts";
import { Engine } from "./engine.ts";
import { playHistory } from "./history.testutil.ts";
import { EventStore } from "./store.ts";

async function memoryStore(): Promise<EventStore> {
  return new EventStore(await openDatabase(":memory:"));
}
const quiet = { log: () => undefined, snapshotEvery: 0 };
const rows = (store: EventStore): number => store.readAll().length;
const deltaRows = (store: EventStore, turnId: string): number =>
  store.readAll().filter((r) => (r.event.type === "assistant.delta" || r.event.type === "assistant.reasoning-delta") && r.event.turnId === turnId).length;

const rec = (seq: number, event: DomainEvent): EventRecord => ({ seq, ts: seq, event });
const text = (seq: number, messageId: string, delta: string, turnId = "u1"): EventRecord =>
  rec(seq, { type: "assistant.delta", threadId: "t", turnId, messageId, delta, at: seq });
const think = (seq: number, messageId: string, delta: string, turnId = "u1"): EventRecord =>
  rec(seq, { type: "assistant.reasoning-delta", threadId: "t", turnId, messageId, delta, at: seq });
const tool = (seq: number): EventRecord =>
  rec(seq, { type: "activity.upserted", activity: { id: `a${seq}`, threadId: "t", turnId: "u1", kind: "tool", toolUseId: "x", toolName: "Bash", input: {}, status: "ok", createdAt: 1, updatedAt: 1 } });
const settled = (seq: number): EventRecord => rec(seq, { type: "turn.settled", threadId: "t", turnId: "u1", status: "completed", settledAt: seq, at: seq } as DomainEvent);

describe("planCompaction (the merge rule)", () => {
  const all = (): boolean => true;

  it("merges a message's chunks into the first one, across activities and the other kind of delta", () => {
    const plan = planCompaction([think(1, "m", "a"), text(2, "m", "x"), think(3, "m", "b"), tool(4), text(5, "m", "y"), text(6, "n", "other"), text(7, "m", "z"), settled(8)], all);
    expect(plan.rewrites).toEqual([
      { seq: 1, ts: 1, event: { ...think(1, "m", "ab").event } },
      { seq: 2, ts: 2, event: { ...text(2, "m", "xyz").event } },
    ]);
    expect(plan.deletes.sort((a, b) => a - b)).toEqual([3, 5, 7]);
    expect(plan.spans).toEqual([
      [1, 3],
      [2, 7],
    ]);
  });

  it("ends every run at any other event of the thread", () => {
    const edited = rec(3, { type: "turn.edited", threadId: "t", turnId: "u1", messageId: "m", text: "new", at: 3 } as DomainEvent);
    const plan = planCompaction([text(1, "m", "a"), text(2, "m", "b"), edited, text(4, "m", "c"), text(5, "m", "d")], all);
    expect(plan.spans).toEqual([
      [1, 2],
      [4, 5],
    ]);
  });

  it("never touches a turn that has not settled, and reports where it starts", () => {
    const plan = planCompaction([text(1, "m", "a", "done"), text(2, "m", "b", "done"), text(3, "r", "c", "live"), text(4, "r", "d", "live")], (id) => id === "done");
    expect(plan.spans).toEqual([[1, 2]]);
    expect(plan.deferredFrom).toBe(3);
  });

  it("projects to the same model as the chunks it replaces", () => {
    const records = [think(1, "m", "a"), text(2, "m", "x"), think(3, "m", "b"), tool(4), text(5, "m", "y"), text(6, "n", "other"), text(7, "m", "z")];
    const plan = planCompaction(records, all);
    const deleted = new Set(plan.deletes);
    const byseq = new Map(plan.rewrites.map((r) => [r.seq, r]));
    const compacted = records.filter((r) => !deleted.has(r.seq)).map((r) => byseq.get(r.seq) ?? r);
    expect(replay(emptyReadModel(), compacted).messages).toEqual(replay(emptyReadModel(), records).messages);
  });
});

describe("delta compaction on a store", () => {
  it("rewrites settled history to far fewer rows with an identical model, and is idempotent", async () => {
    const store = await memoryStore();
    const engine = new Engine({ store, ...quiet, compaction: false });
    const h = await playHistory(engine, { threads: 3, turnsPerThread: 5, chunks: 12, leaveRunning: true, seed: 21 });
    const before = engine.getModel();
    const rowsBefore = rows(store);
    const runningRows = deltaRows(store, h.runningTurnId ?? "");

    const stats = engine.compact();
    expect(stats.deleted).toBeGreaterThan(0);
    expect(rows(store)).toBe(rowsBefore - stats.deleted);
    expect(rows(store)).toBeLessThan(rowsBefore / 2);
    expect(replay(emptyReadModel(), store.readAll())).toEqual(before);
    // the running turn is left exactly as it was
    expect(deltaRows(store, h.runningTurnId ?? "")).toBe(runningRows);
    // and the watermark stops before it, so it is looked at again once it settles
    expect(store.compaction.watermark()).toBeLessThan(store.lastSeq());

    expect(engine.compact()).toEqual({ runs: 0, deleted: 0 });
    expect(rows(store)).toBe(rowsBefore - stats.deleted);

    await engine.dispatch({ type: "assistant.append", turnId: h.runningTurnId ?? "", messageId: "late", delta: "x" });
    await engine.dispatch({ type: "assistant.append", turnId: h.runningTurnId ?? "", messageId: "late", delta: "y" });
    await engine.dispatch({ type: "turn.settle", turnId: h.runningTurnId ?? "", status: "completed" });
    const settledModel = engine.getModel();
    const second = engine.compact();
    expect(second.deleted).toBeGreaterThan(0);
    expect(deltaRows(store, h.runningTurnId ?? "")).toBeLessThan(runningRows);
    expect(replay(emptyReadModel(), store.readAll())).toEqual(settledModel);
    expect(store.compaction.watermark()).toBe(store.lastSeq());
  });

  it("compacts each turn as it settles, without changing the model or what the engine published", async () => {
    const plain = await memoryStore();
    const compacted = await memoryStore();
    const a = new Engine({ store: plain, ...quiet, compaction: false });
    const b = new Engine({ store: compacted, ...quiet });
    const published: EventRecord[] = [];
    b.subscribe((r) => published.push(r));
    // same seed, same ids: identical logs except for compaction (ids come from the clock-free newId, so compare shapes)
    await playHistory(a, { threads: 2, turnsPerThread: 4, seed: 4 });
    await playHistory(b, { threads: 2, turnsPerThread: 4, seed: 4 });
    expect(published.length).toBe(rows(plain));
    expect(rows(compacted)).toBeLessThan(rows(plain) / 2);
    expect(replay(emptyReadModel(), compacted.readAll())).toEqual(b.getModel());
    expect(b.getModel().seq).toBe(a.getModel().seq);
    // a reboot over the compacted log matches the live model
    expect(new Engine({ store: compacted, ...quiet }).getModel()).toEqual(b.getModel());
  });

  it("drops a stored snapshot taken inside a run it merges", async () => {
    const store = await memoryStore();
    const engine = new Engine({ store, ...quiet });
    const h = await playHistory(engine, { threads: 1, turnsPerThread: 1, leaveRunning: true, seed: 8 });
    const turnId = h.runningTurnId ?? "";
    const snap = engine.snapshot(); // mid-run of the second message
    await engine.dispatch({ type: "assistant.append", turnId, messageId: `msg-s8-0-0-b`, delta: "tail" });
    await engine.dispatch({ type: "turn.settle", turnId, status: "completed" });
    await engine.drain();
    expect(snap).toBeDefined();
    expect(store.snapshots.latestSeq()).toBe(0);
    const lines: string[] = [];
    expect(new Engine({ store, ...quiet, log: (m) => lines.push(m) }).getModel()).toEqual(engine.getModel());
    expect(lines[0]).toContain("from the start");
  });
});

describe("catch-up across compacted history", () => {
  /** What `packages/client` modelStore does with a chunk. */
  const applyChunk = (model: ReadModel, chunk: { kind: string; model?: ReadModel; record?: EventRecord }): ReadModel =>
    chunk.kind === "snapshot" ? (chunk.model as ReadModel) : applyRecord(model, chunk.record as EventRecord);

  it("converges from before, inside and after every compacted run", async () => {
    const { RpcRouter } = await import("../rpc/router.ts");
    const { registerHandlers } = await import("../rpc/handlers.ts");
    const { DriverRegistry } = await import("../provider/registry.ts");
    const store = await memoryStore();
    const engine = new Engine({ store, ...quiet, compaction: false });
    await playHistory(engine, { threads: 2, turnsPerThread: 3, chunks: 6, seed: 33 });
    const original = store.readAll();
    // a client that applied the log up to S, one record at a time (what live clients saw)
    const clientAt = (s: number): ReadModel => replay(emptyReadModel(), original.filter((r) => r.seq <= s));

    engine.compact();
    const spans = store.sideTable("").prepare("SELECT first_seq, last_seq FROM compacted_spans").all().map((r) => [Number(r["first_seq"]), Number(r["last_seq"])] as const);
    expect(spans.length).toBeGreaterThan(0);
    const probes = new Set<number>([0, 1, store.lastSeq()]);
    for (const [first, last] of spans) for (const s of [first - 1, first, Math.floor((first + last) / 2), last - 1, last]) probes.add(s);

    const router = new RpcRouter();
    registerHandlers(router, { engine, store, registry: new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } }), environmentId: "env", version: "t", startedAt: 0 });
    const frames: Array<{ id: string; chunk?: { kind: string; model?: ReadModel; record?: EventRecord } }> = [];
    const conn = router.connection("c", (f) => frames.push(f as (typeof frames)[number]));
    let snapshots = 0;
    let n = 0;
    for (const s of [...probes].sort((a, b) => a - b)) {
      const id = `s${++n}`;
      await conn.handleRequest(id, "model.subscribe", { fromSeq: s });
      let model = clientAt(s);
      for (const f of frames.filter((x) => x.id === id && x.chunk)) {
        if (f.chunk?.kind === "snapshot") snapshots++;
        model = applyChunk(model, f.chunk ?? { kind: "?" });
      }
      expect(model, `client at seq ${s}`).toEqual(engine.getModel());
    }
    expect(snapshots).toBeGreaterThan(0); // the inside-a-run probes were answered with one
    // and a client at a run's edge resumed from a tail, not a snapshot
    const [first] = spans[0] ?? [0];
    expect(store.compaction.inside(first - 1)).toBe(false);
    expect(store.compaction.inside(first)).toBe(true);
    // which is needed: a plain tail from inside the run would lose text
    const naive = replay(clientAt(first), store.readFrom(first + 1));
    expect(naive).not.toEqual(engine.getModel());
  });
});
