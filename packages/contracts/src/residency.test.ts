import { describe, it, expect } from "vitest";
import { applyRecord, emptyReadModel, isResidentActivity, mergeActivities, replay, residentModel, threadActivitiesOf, type Activity, type EventRecord } from "./index.ts";

const rec = (seq: number, event: EventRecord["event"]): EventRecord => ({ seq, ts: seq, event });
const tool = (id: string, turnId: string, status: "running" | "ok", updatedAt = 1): Activity =>
  ({ id, threadId: "t1", turnId, kind: "tool", toolUseId: id, toolName: "Read", input: {}, status, createdAt: 1, updatedAt }) as Activity;

function base() {
  return replay(emptyReadModel(), [
    rec(1, { type: "project.created", project: { id: "p1", title: "T", rootPath: "/x", createdAt: 1, updatedAt: 1 } }),
    rec(2, { type: "thread.created", thread: { id: "t1", projectId: "p1", title: "A", provider: "claude", mode: "approval-required", interaction: "default", status: "idle", createdAt: 2, updatedAt: 2 } }),
    rec(3, { type: "turn.requested", turn: { id: "u1", threadId: "t1", status: "requested", requestedAt: 3 }, userMessage: { id: "m1", threadId: "t1", turnId: "u1", role: "user", text: "hi", createdAt: 3 } }),
    rec(4, { type: "activity.upserted", activity: tool("a1", "u1", "ok") }),
    rec(5, { type: "activity.upserted", activity: tool("a2", "u1", "running") }),
    rec(6, { type: "turn.settled", turnId: "u1", threadId: "t1", status: "completed", settledAt: 6 }),
    rec(7, { type: "turn.requested", turn: { id: "u2", threadId: "t1", status: "requested", requestedAt: 7 }, userMessage: { id: "m2", threadId: "t1", turnId: "u2", role: "user", text: "more", createdAt: 7 } }),
    rec(8, { type: "activity.upserted", activity: tool("a3", "u2", "ok") }),
    rec(9, { type: "activity.upserted", activity: { id: "q1", threadId: "t1", turnId: "u2", kind: "approval", requestId: "r1", toolName: "Bash", input: {}, status: "pending", createdAt: 9, updatedAt: 9 } as Activity }),
  ]);
}

describe("activity residency", () => {
  it("keeps pending prompts, running work and the in-flight turn; drops settled turns' activities", () => {
    const m = base();
    const r = residentModel(m);
    expect(Object.keys(r.activities).sort()).toEqual(["a3", "q1"]);
    // a2 was running when u1 settled: the projector closed it, so it is no longer resident
    expect(isResidentActivity(m, m.activities["a2"]!)).toBe(false);
    expect(r.threadTimeline).toBe(m.threadTimeline);
  });

  it("keeps the tool rows of a sub-agent still running from a settled turn", () => {
    const child = { id: "c1", threadId: "t1", turnId: "u1", kind: "child", childKey: "k1", name: "scout", status: "running", createdAt: 1, updatedAt: 1 } as Activity;
    const under = { ...tool("a7", "u1", "ok"), parentToolUseId: "k1" } as Activity;
    const other = { ...tool("a8", "u1", "ok"), parentToolUseId: "k2" } as Activity;
    const m = { ...base(), activities: { ...base().activities, c1: child, a7: under, a8: other } };
    expect(Object.keys(residentModel(m).activities).sort()).toEqual(["a3", "a7", "c1", "q1"]);
  });

  it("an upsert of an activity the client lacks does not duplicate its timeline entry", () => {
    const m = base();
    const r = residentModel(m);
    const next = applyRecord(r, rec(10, { type: "activity.upserted", activity: tool("a1", "u1", "ok", 10) }));
    expect(next.threadTimeline["t1"]?.filter((e) => e.id === "a1")).toHaveLength(1);
    expect(next.activities["a1"]?.updatedAt).toBe(10);
    const fresh = applyRecord(next, rec(11, { type: "activity.upserted", activity: tool("a9", "u2", "ok", 11) }));
    expect(fresh.threadTimeline["t1"]?.at(-1)).toEqual({ kind: "activity", id: "a9" });
  });

  it("serves a window of turns in timeline order", () => {
    const m = base();
    expect(threadActivitiesOf(m, "t1", ["u1"]).map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(threadActivitiesOf(m, "t1", ["u2", "u1"]).map((a) => a.id)).toEqual(["a1", "a2", "a3", "q1"]);
    expect(threadActivitiesOf(m, "nope", ["u1"])).toEqual([]);
  });

  it("merge keeps the newer copy and returns the same map when nothing changes", () => {
    const held = { a1: tool("a1", "u1", "ok", 5) };
    expect(mergeActivities(held, [tool("a1", "u1", "ok", 4)])).toBe(held);
    expect(mergeActivities(held, [tool("a1", "u1", "ok", 5)])).toBe(held);
    const merged = mergeActivities(held, [tool("a1", "u1", "ok", 6), tool("a2", "u1", "ok", 1)]);
    expect(merged).not.toBe(held);
    expect(merged["a1"]?.updatedAt).toBe(6);
    expect(Object.keys(merged)).toEqual(["a1", "a2"]);
  });
});
