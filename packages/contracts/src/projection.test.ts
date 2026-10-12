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

describe("projection — W2 queued turns, dequeue, reasoning", () => {
  const base = replay(emptyReadModel(), [
    rec(1, { type: "project.created", project: { id: "p1", title: "T", rootPath: "/x", createdAt: 1, updatedAt: 1 } }),
    rec(2, { type: "thread.created", thread: { id: "t1", projectId: "p1", title: "New", provider: "claude", mode: "approval-required", interaction: "default", status: "idle", createdAt: 2, updatedAt: 2 } }),
    rec(3, { type: "turn.requested", turn: { id: "u1", threadId: "t1", status: "requested", requestedAt: 3 }, userMessage: { id: "m1", threadId: "t1", turnId: "u1", role: "user", text: "first", createdAt: 3 } }),
    rec(4, { type: "turn.requested", turn: { id: "u2", threadId: "t1", status: "queued", requestedAt: 4 }, userMessage: { id: "m2", threadId: "t1", turnId: "u2", role: "user", text: "second", attachments: [{ mediaType: "image/png", bytes: 12 }], createdAt: 4 }, images: [{ mediaType: "image/png", data: "AAAA" }] }),
  ]);
  it("a queued turn does not take over the thread; settling promotes it", () => {
    expect(base.threads["t1"]).toMatchObject({ status: "running", latestTurnId: "u1" });
    expect(base.threadTimeline["t1"]?.map((e) => e.id)).toEqual(["m1", "m2"]);
    expect(base.messages["m2"]?.attachments).toEqual([{ mediaType: "image/png", bytes: 12 }]);
    const m = applyRecord(base, rec(5, { type: "turn.settled", turnId: "u1", threadId: "t1", status: "completed", settledAt: 5 }));
    expect(m.threads["t1"]).toMatchObject({ status: "running", latestTurnId: "u2" });
    expect(m.turns["u2"]?.status).toBe("requested");
    const m2 = applyRecord(m, rec(6, { type: "turn.settled", turnId: "u2", threadId: "t1", status: "completed", settledAt: 6 }));
    expect(m2.threads["t1"]?.status).toBe("idle");
  });
  it("dequeue removes the turn and its message", () => {
    const m = applyRecord(base, rec(5, { type: "turn.dequeued", turnId: "u2", threadId: "t1", at: 5 }));
    expect(m.turns["u2"]).toBeUndefined();
    expect(m.messages["m2"]).toBeUndefined();
    expect(m.threadMessages["t1"]).toEqual(["m1"]);
    expect(m.threadTimeline["t1"]?.map((e) => e.id)).toEqual(["m1"]);
    const settled = applyRecord(m, rec(6, { type: "turn.settled", turnId: "u1", threadId: "t1", status: "completed", settledAt: 6 }));
    expect(settled.threads["t1"]).toMatchObject({ status: "idle", latestTurnId: "u1" });
  });
  it("reasoning deltas open the message and precede its text", () => {
    const m = replay(base, [
      rec(5, { type: "assistant.reasoning-delta", turnId: "u1", threadId: "t1", messageId: "a1", delta: "think", at: 5 }),
      rec(6, { type: "assistant.reasoning-delta", turnId: "u1", threadId: "t1", messageId: "a1", delta: "ing", at: 6 }),
      rec(7, { type: "assistant.delta", turnId: "u1", threadId: "t1", messageId: "a1", delta: "answer", at: 7 }),
    ]);
    expect(m.messages["a1"]).toMatchObject({ reasoning: "thinking", text: "answer", streaming: true });
    expect(m.threadTimeline["t1"]?.map((e) => e.id)).toEqual(["m1", "m2", "a1"]);
  });
});

describe("projection — R3 usage deltas, request ids, merge-back", () => {
  const base = replay(emptyReadModel(), [
    rec(1, { type: "project.created", project: { id: "p1", title: "T", rootPath: "/x", createdAt: 1, updatedAt: 1 } }),
    rec(2, { type: "thread.created", thread: { id: "t1", projectId: "p1", title: "New", provider: "claude", mode: "auto", interaction: "default", status: "idle", worktreePath: "/w", branch: "tide/x", baseBranch: "main", createdAt: 2, updatedAt: 2 } }),
    rec(3, { type: "turn.requested", turn: { id: "u1", threadId: "t1", status: "requested", requestedAt: 3 }, userMessage: { id: "m1", threadId: "t1", turnId: "u1", role: "user", text: "a", createdAt: 3 } }),
    rec(4, { type: "turn.started", turnId: "u1", threadId: "t1", provider: "claude", nativeSessionId: "s1", startedAt: 4 }),
  ]);
  it("sums usage reports into the turn and the thread cost", () => {
    const m = replay(base, [
      rec(5, { type: "usage.reported", turnId: "u1", threadId: "t1", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, costUsd: 0.1 }, at: 5 }),
      rec(6, { type: "usage.reported", turnId: "u1", threadId: "t1", usage: { inputTokens: 20, outputTokens: 1, costUsd: 0.2 }, rateLimit: { status: "warning", remainingPct: 12, at: 6 }, at: 6 }),
      rec(7, { type: "turn.settled", turnId: "u1", threadId: "t1", status: "completed", settledAt: 7 }),
      rec(8, { type: "turn.requested", turn: { id: "u2", threadId: "t1", status: "requested", requestedAt: 8 }, userMessage: { id: "m2", threadId: "t1", turnId: "u2", role: "user", text: "b", createdAt: 8 } }),
      rec(9, { type: "usage.reported", turnId: "u2", threadId: "t1", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.5 }, at: 9 }),
    ]);
    expect(m.turns["u1"]?.usage).toEqual({ inputTokens: 30, outputTokens: 6, cacheReadTokens: 100, costUsd: 0.30000000000000004 });
    expect(m.turns["u2"]?.usage).toEqual({ inputTokens: 1, outputTokens: 1, costUsd: 0.5 });
    expect(m.threads["t1"]?.totalCostUsd).toBeCloseTo(0.8);
    expect(m.threads["t1"]?.rateLimit).toMatchObject({ status: "warning", remainingPct: 12 });
  });
  it("a repeated requestId resolves the newest pending approval, never the old resolved one", () => {
    const m = replay(base, [
      rec(5, { type: "activity.upserted", activity: { id: "a1", kind: "approval", threadId: "t1", turnId: "u1", requestId: "0", toolName: "Bash", input: {}, status: "pending", createdAt: 5, updatedAt: 5 } }),
      rec(6, { type: "approval.responded", threadId: "t1", requestId: "0", activityId: "a1", decision: "accept", at: 6 }),
      rec(7, { type: "activity.upserted", activity: { id: "a2", kind: "approval", threadId: "t1", turnId: "u1", requestId: "0", toolName: "Edit", input: {}, status: "pending", createdAt: 7, updatedAt: 7 } }),
    ]);
    expect(m.threads["t1"]?.attention).toBe("approval");
    const byId = applyRecord(m, rec(8, { type: "approval.responded", threadId: "t1", requestId: "0", activityId: "a2", decision: "decline", at: 8 }));
    expect(byId.activities["a2"]).toMatchObject({ status: "resolved", decision: "decline" });
    expect(byId.activities["a1"]).toMatchObject({ decision: "accept" });
    const legacy = applyRecord(m, rec(8, { type: "approval.responded", threadId: "t1", requestId: "0", decision: "decline", at: 8 }));
    expect(legacy.activities["a2"]).toMatchObject({ status: "resolved", decision: "decline" });
    expect(legacy.threads["t1"]?.attention).toBeUndefined();
  });
  it("a provider switch drops the native session id", () => {
    const m = applyRecord(base, rec(5, { type: "thread.updated", threadId: "t1", patch: { provider: "codex" }, clearNativeSession: true, updatedAt: 5 }));
    expect(m.threads["t1"]).toMatchObject({ provider: "codex" });
    expect(m.threads["t1"]?.nativeSessionId).toBeUndefined();
  });
  it("merge-back lifecycle: merging → conflicted → merging → merged; PR merged sets mergedAt", () => {
    const m = replay(base, [
      rec(5, { type: "merge.requested", threadId: "t1", strategy: "squash", at: 5 }),
      rec(6, { type: "merge.conflicted", threadId: "t1", strategy: "squash", files: ["a.ts"], at: 6 }),
    ]);
    expect(m.threads["t1"]?.merge).toEqual({ status: "conflicted", strategy: "squash", files: ["a.ts"], at: 6 });
    expect(m.threads["t1"]?.mergedAt).toBeUndefined();
    const done = replay(m, [
      rec(7, { type: "merge.requested", threadId: "t1", strategy: "rebase", at: 7 }),
      rec(8, { type: "merge.completed", threadId: "t1", strategy: "rebase", sha: "abc", at: 8 }),
    ]);
    expect(done.threads["t1"]).toMatchObject({ merge: { status: "merged", sha: "abc" }, mergedAt: 8 });
    const viaPr = applyRecord(base, rec(5, { type: "pr.updated", threadId: "t1", pr: { url: "u", number: 1, state: "merged", updatedAt: 5 } }));
    expect(viaPr.threads["t1"]?.mergedAt).toBe(5);
    const triaged = applyRecord(base, rec(5, { type: "thread.triaged", threadId: "t1", triage: { needsUser: 0.9, stuck: 0.1, urgency: 0.7, at: 5 } }));
    expect(triaged.threads["t1"]?.triage?.needsUser).toBe(0.9);
  });
});
