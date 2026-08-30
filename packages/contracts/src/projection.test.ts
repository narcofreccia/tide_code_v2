import { describe, it, expect } from "vitest";
import { emptyReadModel, replay, applyRecord, type EventRecord } from "./index.ts";

const rec = (seq: number, event: EventRecord["event"]): EventRecord => ({ seq, ts: seq, event });

describe("projection", () => {
  it("replays project/thread/turn lifecycle", () => {
    const m = replay(emptyReadModel(), [
      rec(1, { type: "project.created", project: { id: "p1", title: "T", rootPath: "/x", createdAt: 1, updatedAt: 1 } }),
      rec(2, { type: "thread.created", thread: { id: "t1", projectId: "p1", title: "New", provider: "claude", mode: "approval-required", interaction: "default", status: "idle", createdAt: 2, updatedAt: 2 } }),
      rec(3, { type: "turn.requested", turn: { id: "u1", threadId: "t1", status: "requested", requestedAt: 3 }, userMessage: { id: "m1", threadId: "t1", turnId: "u1", role: "user", text: "hi", createdAt: 3 } }),
      rec(4, { type: "assistant.delta", turnId: "u1", threadId: "t1", messageId: "m2", delta: "hel", at: 4 }),
      rec(5, { type: "assistant.delta", turnId: "u1", threadId: "t1", messageId: "m2", delta: "lo", at: 5 }),
      rec(6, { type: "turn.settled", turnId: "u1", threadId: "t1", status: "completed", settledAt: 6 }),
    ]);
    expect(m.seq).toBe(6);
    expect(m.threads["t1"]?.status).toBe("idle");
    expect(m.threadMessages["t1"]).toEqual(["m1", "m2"]);
    expect(m.messages["m2"]).toMatchObject({ text: "hello", streaming: false });
    expect(m.turns["u1"]?.status).toBe("completed");
  });
  it("ignores already-applied seqs", () => {
    const base = replay(emptyReadModel(), [rec(1, { type: "project.created", project: { id: "p1", title: "T", rootPath: "/x", createdAt: 1, updatedAt: 1 } })]);
    const again = applyRecord(base, rec(1, { type: "project.archived", projectId: "p1", archivedAt: 9 }));
    expect(again).toBe(base);
  });
});

describe("projection — P1 activities, plans, attention", () => {
  const base = replay(emptyReadModel(), [
    rec(1, { type: "project.created", project: { id: "p1", title: "T", rootPath: "/x", createdAt: 1, updatedAt: 1 } }),
    rec(2, { type: "thread.created", thread: { id: "t1", projectId: "p1", title: "New", provider: "claude", mode: "approval-required", interaction: "plan", status: "idle", createdAt: 2, updatedAt: 2 } }),
    rec(3, { type: "turn.requested", turn: { id: "u1", threadId: "t1", status: "requested", requestedAt: 3 }, userMessage: { id: "m1", threadId: "t1", turnId: "u1", role: "user", text: "plan it", createdAt: 3 } }),
    rec(4, { type: "turn.started", turnId: "u1", threadId: "t1", provider: "claude", model: "opus", nativeSessionId: "sess-1", startedAt: 4 }),
  ]);
  it("approval pending sets attention, response clears it, timeline is ordered", () => {
    const m = replay(base, [
      rec(5, { type: "activity.upserted", activity: { id: "a1", kind: "tool", threadId: "t1", turnId: "u1", toolUseId: "tu1", toolName: "Read", input: {}, status: "ok", createdAt: 5, updatedAt: 5 } }),
      rec(6, { type: "activity.upserted", activity: { id: "a2", kind: "approval", threadId: "t1", turnId: "u1", requestId: "r1", toolName: "Edit", input: {}, status: "pending", createdAt: 6, updatedAt: 6 } }),
    ]);
    expect(m.threads["t1"]?.attention).toBe("approval");
    expect(m.threads["t1"]?.nativeSessionId).toBe("sess-1");
    expect(m.threadTimeline["t1"]?.map((e) => e.id)).toEqual(["m1", "a1", "a2"]);
    const m2 = applyRecord(m, rec(7, { type: "approval.responded", threadId: "t1", requestId: "r1", decision: "accept", at: 7 }));
    expect(m2.threads["t1"]?.attention).toBeUndefined();
    expect(m2.activities["a2"]).toMatchObject({ status: "resolved", decision: "accept" });
  });
  it("plan proposed keeps attention until implemented; settle clears progress and running tools", () => {
    const m = replay(base, [
      rec(5, { type: "plan.progressed", threadId: "t1", steps: [{ text: "a", status: "completed" }, { text: "b", status: "in_progress" }], at: 5 }),
      rec(6, { type: "activity.upserted", activity: { id: "a1", kind: "tool", threadId: "t1", turnId: "u1", toolUseId: "tu1", toolName: "Bash", input: {}, status: "running", createdAt: 6, updatedAt: 6 } }),
      rec(7, { type: "plan.proposed", plan: { id: "pl1", threadId: "t1", turnId: "u1", markdown: "# Plan", status: "proposed", createdAt: 7, updatedAt: 7 } }),
      rec(8, { type: "usage.reported", turnId: "u1", threadId: "t1", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 }, contextUsage: { used: 1000, window: 200000 }, at: 8 }),
      rec(9, { type: "turn.settled", turnId: "u1", threadId: "t1", status: "completed", settledAt: 9 }),
    ]);
    expect(m.threads["t1"]).toMatchObject({ status: "idle", attention: "plan", totalCostUsd: 0.5, contextUsage: { used: 1000, window: 200000 } });
    expect(m.threads["t1"]?.planProgress).toBeUndefined();
    expect(m.activities["a1"]).toMatchObject({ status: "ok" });
    const m2 = applyRecord(m, rec(10, { type: "plan.updated", planId: "pl1", status: "implemented", implementationThreadId: "t2", at: 10 }));
    expect(m2.threads["t1"]?.attention).toBeUndefined();
    expect(m2.plans["pl1"]?.implementationThreadId).toBe("t2");
  });
});
