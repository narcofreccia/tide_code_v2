import { describe, expect, it } from "vitest";
import { emptyReadModel, type Activity, type ReadModel, type Thread } from "@tide/contracts";
import { childThreadsOf, selectChildAttention, selectChildRequests } from "./childRequests.ts";

const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p1",
  title: id,
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: Number(id.replace(/\D/g, "")) || 1,
  updatedAt: 1,
  ...extra,
});

function approval(id: string, threadId: string, createdAt: number, status: "pending" | "approved" = "pending"): Activity {
  return { id, kind: "approval", threadId, turnId: `u-${threadId}`, requestId: id, title: "Run", status, createdAt, updatedAt: createdAt } as Activity;
}

function model(): ReadModel {
  const m = emptyReadModel();
  const threads: Thread[] = [
    thread("t1"),
    thread("t2", { delegatedBy: "t1", role: "delegate", attention: "approval" }),
    thread("t3", { parentThreadId: "t1", role: "side", attention: "question" }),
    thread("t4", { parentThreadId: "t1" }), // fork: not a child
    thread("t5", { delegatedBy: "t1", archivedAt: 9, attention: "approval" }),
    thread("t6", { delegatedBy: "t9" }),
  ];
  for (const t of threads) m.threads[t.id] = t;
  const a1 = approval("a1", "t2", 20);
  const a0 = approval("a0", "t4", 5);
  const q1: Activity = { id: "q1", kind: "user-input", threadId: "t3", turnId: "u-t3", requestId: "q1", questions: [{ id: "x", text: "?" }], status: "pending", createdAt: 10, updatedAt: 10 } as Activity;
  const done = approval("a2", "t2", 1, "approved");
  for (const a of [a1, a0, q1, done]) m.activities[a.id] = a;
  m.threadTimeline["t2"] = [{ kind: "activity", id: "a2" }, { kind: "activity", id: "a1" }];
  m.threadTimeline["t3"] = [{ kind: "activity", id: "q1" }];
  m.threadTimeline["t4"] = [{ kind: "activity", id: "a0" }];
  return m;
}

describe("childThreadsOf", () => {
  it("lists delegates and side chats, never forks, archived children or other parents' children", () => {
    expect(childThreadsOf(model(), "t1").map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(childThreadsOf(model(), "missing")).toEqual([]);
  });
  it("a lead's experts are its children", () => {
    const m = model();
    m.threads["lead"] = thread("lead", { role: "lead", expertsSessionId: "s1" });
    m.threads["e1"] = thread("e1", { role: "expert", expertsSessionId: "s1" });
    m.threads["e2"] = thread("e2", { role: "expert", expertsSessionId: "other" });
    expect(childThreadsOf(m, "lead").map((t) => t.id)).toEqual(["e1"]);
  });
});

describe("selectChildRequests", () => {
  it("returns the children's pending cards oldest first, skipping resolved ones and plans", () => {
    const items = selectChildRequests(model(), "t1");
    expect(items.map((i) => [i.key, i.thread.id, i.attention])).toEqual([
      ["q1", "t3", "question"],
      ["a1", "t2", "approval"],
    ]);
  });
  it("is empty when nothing waits", () => {
    const m = model();
    m.activities["a1"] = approval("a1", "t2", 20, "approved");
    m.threadTimeline["t3"] = [];
    expect(selectChildRequests(m, "t1")).toEqual([]);
  });
});

describe("selectChildAttention", () => {
  it("is true while a child needs the user", () => {
    expect(selectChildAttention(model(), "t1")).toBe(true);
    expect(selectChildAttention(model(), "t9")).toBe(false);
  });
});
