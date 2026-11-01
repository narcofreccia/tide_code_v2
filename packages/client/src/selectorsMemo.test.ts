import { describe, expect, it } from "vitest";
import { emptyReadModel, type Message, type ReadModel, type Thread, type Turn } from "@tide/contracts";
import {
  memoByRef,
  selectCheckpointTurns,
  selectDelegates,
  selectLatestSettledTurnId,
  selectQueuedTurns,
  selectThreadTurns,
  selectTurnPrompt,
} from "./selectors.ts";

const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p1",
  title: id,
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const turn = (id: string, status: Turn["status"], requestedAt: number, patch: Partial<Turn> = {}): Turn => ({
  id,
  threadId: "t1",
  status,
  requestedAt,
  ...patch,
});

function model(turns: Turn[], threads: Thread[] = [thread("t1")]): ReadModel {
  return {
    ...emptyReadModel(),
    threads: Object.fromEntries(threads.map((t) => [t.id, t])),
    turns: Object.fromEntries(turns.map((t) => [t.id, t])),
  };
}

describe("memoByRef", () => {
  it("computes once per map object and key", () => {
    let calls = 0;
    const size = memoByRef((map: Record<string, number>, key: string) => {
      calls += 1;
      return `${key}:${Object.keys(map).length}`;
    });
    const a = { x: 1 };
    expect(size(a, "k")).toBe("k:1");
    expect(size(a, "k")).toBe("k:1");
    expect(calls).toBe(1);
    expect(size(a, "j")).toBe("j:1");
    expect(size({ x: 1, y: 2 }, "k")).toBe("k:2");
    expect(calls).toBe(3);
  });
});

describe("turn selectors keyed on the turns map", () => {
  const turns = [
    turn("u1", "completed", 10, { checkpoint: { before: "a", after: "b" } as Turn["checkpoint"] }),
    turn("u2", "error", 20),
    turn("u3", "running", 30),
    turn("u4", "queued", 40),
    turn("x1", "queued", 5, { threadId: "t2" }),
  ];

  it("returns the same array while the turns map keeps its identity", () => {
    const m = model(turns);
    // a streaming delta replaces messages, never turns
    const next: ReadModel = { ...m, seq: m.seq + 1, messages: { ...m.messages } };
    expect(selectThreadTurns(next, "t1")).toBe(selectThreadTurns(m, "t1"));
    expect(selectQueuedTurns(next, "t1")).toBe(selectQueuedTurns(m, "t1"));
    expect(selectCheckpointTurns(next, "t1")).toBe(selectCheckpointTurns(m, "t1"));
    expect(selectThreadTurns(m, "t1").map((t) => t.id)).toEqual(["u1", "u2", "u3", "u4"]);
    expect(selectQueuedTurns(m, "t1").map((t) => t.id)).toEqual(["u4"]);
    expect(selectCheckpointTurns(m, "t1").map((t) => t.id)).toEqual(["u1"]);
    expect(selectLatestSettledTurnId(m, "t1")).toBe("u2");
  });

  it("recomputes for a new turns map", () => {
    const m = model(turns);
    const before = selectQueuedTurns(m, "t1");
    const next: ReadModel = { ...m, turns: { ...m.turns, u5: turn("u5", "queued", 50) } };
    const after = selectQueuedTurns(next, "t1");
    expect(after).not.toBe(before);
    expect(after.map((t) => t.id)).toEqual(["u4", "u5"]);
    const settled: ReadModel = { ...next, turns: { ...next.turns, u3: turn("u3", "completed", 30) } };
    expect(selectLatestSettledTurnId(settled, "t1")).toBe("u3");
  });

  it("keeps threads apart in one map", () => {
    const m = model(turns);
    expect(selectQueuedTurns(m, "t2").map((t) => t.id)).toEqual(["x1"]);
    expect(selectThreadTurns(m, "none")).toEqual([]);
    expect(selectLatestSettledTurnId(m, "t2")).toBeUndefined();
  });
});

describe("selectDelegates keyed on the threads map", () => {
  it("memoizes on threads identity and recomputes on a new map", () => {
    const threads = [thread("t1"), thread("d2", { delegatedBy: "t1", createdAt: 2 }), thread("d1", { delegatedBy: "t1", createdAt: 1 })];
    const m = model([], threads);
    const first = selectDelegates(m, "t1");
    expect(first.map((t) => t.id)).toEqual(["d1", "d2"]);
    expect(selectDelegates({ ...m, seq: 9 }, "t1")).toBe(first);
    const archived: ReadModel = { ...m, threads: { ...m.threads, d1: thread("d1", { delegatedBy: "t1", archivedAt: 3 }) } };
    expect(selectDelegates(archived, "t1").map((t) => t.id)).toEqual(["d2"]);
  });
});

describe("selectTurnPrompt", () => {
  it("reads the thread's own messages only", () => {
    const user = (id: string, threadId: string, turnId: string): Message => ({ id, threadId, turnId, role: "user", text: `prompt ${id}`, createdAt: 1 });
    const m: ReadModel = {
      ...model([]),
      messages: { m1: user("m1", "t1", "u1"), m2: user("m2", "t2", "u2") },
      threadMessages: { t1: ["m1"], t2: ["m2"] },
    };
    expect(selectTurnPrompt(m, "t1", "u1")).toBe("prompt m1");
    expect(selectTurnPrompt(m, "t1", "u2")).toBeUndefined();
  });
});
