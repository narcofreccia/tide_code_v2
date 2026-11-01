import { describe, expect, it } from "vitest";
import { applyRecord, type Activity, type Command, type EventRecord, type ReadModel, type RpcFrame } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { DriverRegistry } from "../provider/registry.ts";
import { COALESCE_MS, createDeltaCoalescer, type CoalesceTimer } from "./coalesce.ts";
import { registerHandlers } from "./handlers.ts";
import { RpcRouter } from "./router.ts";

/** Manual timer: `fire()` runs whatever is armed, as if the window elapsed. */
function fakeTimer(): CoalesceTimer & { fire(): void; armed(): number; lastMs: number } {
  let next = 0;
  const pending = new Map<number, () => void>();
  const t = {
    lastMs: -1,
    set(fn: () => void, ms: number): unknown {
      t.lastMs = ms;
      const id = ++next;
      pending.set(id, fn);
      return id;
    },
    clear(handle: unknown): void {
      pending.delete(handle as number);
    },
    fire(): void {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    armed: () => pending.size,
  };
  return t;
}

let seq = 0;
const delta = (messageId: string, text: string, type: "assistant.delta" | "assistant.reasoning-delta" = "assistant.delta", threadId = "t1"): EventRecord => {
  seq += 1;
  return { seq, ts: 1000 + seq, event: { type, turnId: "u1", threadId, messageId, delta: text, at: 500 + seq } };
};
const tool = (id: string): EventRecord => {
  seq += 1;
  const activity: Activity = { id, threadId: "t1", turnId: "u1", kind: "tool", toolUseId: id, toolName: "Read", input: {}, status: "running", createdAt: seq, updatedAt: seq };
  return { seq, ts: 1000 + seq, event: { type: "activity.upserted", activity } };
};

function rig(maxChars?: number) {
  const out: EventRecord[] = [];
  const timer = fakeTimer();
  const c = createDeltaCoalescer((r) => out.push(r), { timer, ...(maxChars !== undefined ? { maxChars } : {}) });
  return { out, timer, c };
}

describe("delta coalescer", () => {
  it("merges 20 deltas inside one window into a single record", () => {
    const { out, timer, c } = rig();
    const raw = Array.from({ length: 20 }, (_, i) => delta("m1", `w${i} `));
    for (const r of raw) c.push(r);
    expect(out).toEqual([]);
    expect(timer.lastMs).toBe(COALESCE_MS);
    timer.fire();
    expect(out).toHaveLength(1);
    const first = raw[0]!;
    const last = raw[19]!;
    expect(out[0]).toEqual({
      seq: last.seq,
      ts: last.ts,
      event: { ...first.event, delta: raw.map((r) => (r.event.type === "assistant.delta" ? r.event.delta : "")).join("") },
    });
  });

  it("emits a lone delta unchanged", () => {
    const { out, timer, c } = rig();
    const r = delta("m1", "solo");
    c.push(r);
    timer.fire();
    expect(out).toEqual([r]);
  });

  it("flushes pending deltas before a tool activity, then starts a new run", () => {
    const { out, timer, c } = rig();
    const a = [delta("m1", "a"), delta("m1", "b")];
    const act = tool("tool-1");
    const b = [delta("m1", "c"), delta("m1", "d")];
    for (const r of a) c.push(r);
    c.push(act);
    expect(timer.armed()).toBe(0);
    for (const r of b) c.push(r);
    timer.fire();
    expect(out.map((r) => r.seq)).toEqual([a[1]!.seq, act.seq, b[1]!.seq]);
    expect(out[0]!.event).toMatchObject({ delta: "ab" });
    expect(out[1]).toBe(act);
    expect(out[2]!.event).toMatchObject({ delta: "cd" });
  });

  it("does not merge across messages, threads or delta kinds", () => {
    const { out, timer, c } = rig();
    c.push(delta("m1", "a"));
    c.push(delta("m2", "b"));
    c.push(delta("m2", "c", "assistant.reasoning-delta"));
    c.push(delta("m2", "d", "assistant.reasoning-delta", "t2"));
    timer.fire();
    expect(out.map((r) => (r.event as { delta: string }).delta)).toEqual(["a", "b", "c", "d"]);
  });

  it("close flushes the pending run and disarms the timer", () => {
    const { out, timer, c } = rig();
    c.push(delta("m1", "x"));
    c.push(delta("m1", "y"));
    c.close();
    expect(out).toHaveLength(1);
    expect(out[0]!.event).toMatchObject({ delta: "xy" });
    expect(timer.armed()).toBe(0);
    const late = delta("m1", "z");
    c.push(late);
    expect(out[1]).toBe(late);
  });

  it("splits a run when the merged delta reaches the size cap", () => {
    const { out, timer, c } = rig();
    const chunk = "x".repeat(4096);
    for (let i = 0; i < 5; i++) c.push(delta("m1", chunk));
    expect(out).toHaveLength(1);
    expect((out[0]!.event as { delta: string }).delta).toHaveLength(16 * 1024);
    timer.fire();
    expect(out).toHaveLength(2);
    expect((out[1]!.event as { delta: string }).delta).toHaveLength(4096);
  });
});

/** Deterministic PRNG so a failing seed can be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function engineWithTwoTurns(): Promise<{ engine: Engine; store: EventStore; turns: [string, string]; threads: [string, string] }> {
  const store = new EventStore(await openDatabase(":memory:"));
  const engine = new Engine({ store });
  const project = (await engine.dispatch({ type: "project.create", title: "P", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project");
  const threads: string[] = [];
  const turns: string[] = [];
  for (const provider of ["claude", "codex"] as const) {
    const created = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider })).events[0]?.event;
    if (created?.type !== "thread.created") throw new Error("expected thread");
    await engine.dispatch({ type: "turn.request", threadId: created.thread.id, text: "go" });
    const turn = Object.values(engine.getModel().turns).find((t) => t.threadId === created.thread.id)!;
    await engine.dispatch({ type: "turn.start", turnId: turn.id, provider });
    threads.push(created.thread.id);
    turns.push(turn.id);
  }
  return { engine, store, turns: turns as [string, string], threads: threads as [string, string] };
}

const project = (snapshot: ReadModel, records: EventRecord[]): ReadModel => records.reduce(applyRecord, snapshot);

describe("delta coalescer: projection equivalence", () => {
  it("emitted records project to the same ReadModel as the raw log, for random interleavings", async () => {
    for (let s = 1; s <= 40; s++) {
      const rand = mulberry32(s);
      const { engine, turns, threads } = await engineWithTwoTurns();
      const snapshot = engine.getModel();
      const raw: EventRecord[] = [];
      const emitted: EventRecord[] = [];
      const timer = fakeTimer();
      const c = createDeltaCoalescer((r) => emitted.push(r), { timer, maxChars: 1 + Math.floor(rand() * 40) });
      engine.subscribe((r) => {
        raw.push(r);
        c.push(r);
      });
      // 3 messages over 2 threads; m1 and m2 share thread 0's turn
      const messages: [string, string][] = [[turns[0], "m1"], [turns[0], "m2"], [turns[1], "m3"]];
      const steps = 30 + Math.floor(rand() * 50);
      for (let i = 0; i < steps; i++) {
        const roll = rand();
        const [turnId, messageId] = messages[Math.floor(rand() * messages.length)]!;
        const text = `${s}.${i}${"·".repeat(Math.floor(rand() * 6))}`;
        let command: Command;
        if (roll < 0.5) command = { type: "assistant.append", turnId, messageId, delta: text };
        else if (roll < 0.75) command = { type: "assistant.reasoning.append", turnId, messageId, delta: text };
        else if (roll < 0.9) {
          const ti = rand() < 0.5 ? 0 : 1;
          const activity: Activity = {
            id: `act-${s}-${i % 4}`, threadId: threads[ti], turnId: turns[ti], kind: "tool", toolUseId: `tu-${i}`,
            toolName: "Read", input: { i }, status: rand() < 0.5 ? "running" : "ok", createdAt: i, updatedAt: i,
          };
          command = { type: "activity.upsert", activity };
        } else command = { type: "usage.report", turnId, contextUsage: { used: i, window: 1000 } };
        await engine.dispatch(command);
        if (rand() < 0.15) timer.fire();
      }
      for (const turnId of turns) await engine.dispatch({ type: "turn.settle", turnId, status: "completed" });
      c.close();
      await engine.drain();

      expect(raw.length).toBeGreaterThan(steps);
      expect(emitted.length).toBeLessThanOrEqual(raw.length);
      for (let i = 1; i < emitted.length; i++) expect(emitted[i]!.seq).toBeGreaterThan(emitted[i - 1]!.seq);
      expect(emitted.at(-1)!.seq).toBe(raw.at(-1)!.seq);
      expect(project(snapshot, emitted)).toEqual(project(snapshot, raw));
      expect(project(snapshot, emitted)).toEqual(engine.getModel());
    }
  });
});

describe("model.subscribe coalescing", () => {
  it("merges live deltas on the wire and flushes before other events", async () => {
    const { engine, store, turns } = await engineWithTwoTurns();
    const timer = fakeTimer();
    const router = new RpcRouter();
    registerHandlers(router, {
      engine,
      store,
      registry: new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } }),
      environmentId: "env",
      version: "test",
      startedAt: 0,
      coalesceTimer: timer,
    });
    const frames: RpcFrame[] = [];
    const connection = router.connection("c1", (f) => frames.push(f));
    await connection.handleRequest("s1", "model.subscribe", { fromSeq: engine.getModel().seq - 2 });
    const records = (): EventRecord[] =>
      frames.flatMap((f) => ("chunk" in f && (f.chunk as { kind: string }).kind === "event" ? [(f.chunk as { record: EventRecord }).record] : []));
    expect(records()).toHaveLength(2); // catch-up frames go out raw

    for (const d of ["a", "b", "c"]) await engine.dispatch({ type: "assistant.append", turnId: turns[0], messageId: "m1", delta: d });
    expect(records()).toHaveLength(2);
    timer.fire();
    expect(records().at(-1)!.event).toMatchObject({ type: "assistant.delta", delta: "abc" });

    await engine.dispatch({ type: "assistant.append", turnId: turns[0], messageId: "m1", delta: "d" });
    await engine.dispatch({ type: "turn.settle", turnId: turns[0], status: "completed" });
    const tail = records().slice(-2).map((r) => r.event.type);
    expect(tail).toEqual(["assistant.delta", "turn.settled"]);
    expect(records().at(-1)!.seq).toBe(engine.getModel().seq);

    await engine.dispatch({ type: "assistant.append", turnId: turns[1], messageId: "m3", delta: "e" });
    expect(connection.cancelStream("s1")).toBe(true);
    expect(timer.armed()).toBe(0);
  });
});
