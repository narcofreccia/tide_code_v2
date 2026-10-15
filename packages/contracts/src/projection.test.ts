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

describe("projection — R4 steer, queue editing, handoff, rollback, limits", () => {
  const base = replay(emptyReadModel(), [
    rec(1, { type: "project.created", project: { id: "p1", title: "T", rootPath: "/x", createdAt: 1, updatedAt: 1 } }),
    rec(2, { type: "thread.created", thread: { id: "t1", projectId: "p1", title: "New", provider: "claude", mode: "auto", interaction: "default", status: "idle", createdAt: 2, updatedAt: 2 } }),
    rec(3, { type: "turn.requested", turn: { id: "u1", threadId: "t1", status: "requested", requestedAt: 3 }, userMessage: { id: "m1", threadId: "t1", turnId: "u1", role: "user", text: "first", createdAt: 3 } }),
    rec(4, { type: "turn.started", turnId: "u1", threadId: "t1", provider: "claude", nativeSessionId: "c-1", startedAt: 4 }),
  ]);

  it("a steer joins the running turn's timeline; a fallback turns it into a queued turn", () => {
    const m = applyRecord(base, rec(5, { type: "turn.steered", turnId: "u1", threadId: "t1", message: { id: "m2", threadId: "t1", turnId: "u1", role: "user", text: "also do X", steer: true, createdAt: 5 } }));
    expect(m.threadTimeline["t1"]?.map((e) => e.id)).toEqual(["m1", "m2"]);
    expect(m.messages["m2"]?.steer).toBe(true);
    const m2 = applyRecord(m, rec(6, {
      type: "turn.steer-fell-back", threadId: "t1", messageId: "m2", reason: "no steer", at: 6,
      turn: { id: "u2", threadId: "t1", status: "queued", requestedAt: 6 },
      userMessage: { id: "m3", threadId: "t1", turnId: "u2", role: "user", text: "also do X", createdAt: 6 },
    }));
    expect(m2.messages["m2"]).toBeUndefined();
    expect(m2.threadTimeline["t1"]?.map((e) => e.id)).toEqual(["m1", "m3"]);
    expect(m2.turns["u2"]?.status).toBe("queued");
    expect(m2.threads["t1"]?.latestTurnId).toBe("u1");
  });

  it("reorder rewrites requestedAt so promotion follows the new order; edit rewrites the text", () => {
    const m = replay(base, [
      rec(5, { type: "turn.requested", turn: { id: "q1", threadId: "t1", status: "queued", requestedAt: 5 }, userMessage: { id: "mq1", threadId: "t1", turnId: "q1", role: "user", text: "a", createdAt: 5 } }),
      rec(6, { type: "turn.requested", turn: { id: "q2", threadId: "t1", status: "queued", requestedAt: 6 }, userMessage: { id: "mq2", threadId: "t1", turnId: "q2", role: "user", text: "b", createdAt: 6 } }),
      rec(7, { type: "turns.reordered", threadId: "t1", turnIds: ["q2", "q1"], at: 7 }),
      rec(8, { type: "turn.edited", turnId: "q2", threadId: "t1", messageId: "mq2", text: "b2", at: 8 }),
      rec(9, { type: "turn.settled", turnId: "u1", threadId: "t1", status: "completed", settledAt: 9 }),
    ]);
    expect(m.messages["mq2"]?.text).toBe("b2");
    expect(m.threads["t1"]?.latestTurnId).toBe("q2");
    expect(m.turns["q2"]?.status).toBe("requested");
    expect(m.turns["q1"]?.status).toBe("queued");
  });

  it("tracks a native session per provider and the last turn each one saw", () => {
    const m = replay(base, [
      rec(5, { type: "turn.settled", turnId: "u1", threadId: "t1", status: "completed", settledAt: 5 }),
      rec(6, { type: "thread.updated", threadId: "t1", patch: { provider: "codex" }, clearNativeSession: true, updatedAt: 6 }),
      rec(7, { type: "turn.requested", turn: { id: "u2", threadId: "t1", status: "requested", requestedAt: 7 }, userMessage: { id: "m2", threadId: "t1", turnId: "u2", role: "user", text: "go", createdAt: 7 } }),
      rec(8, { type: "turn.started", turnId: "u2", threadId: "t1", provider: "codex", nativeSessionId: "x-1", startedAt: 8 }),
      rec(9, { type: "turn.settled", turnId: "u2", threadId: "t1", status: "completed", settledAt: 9 }),
      rec(10, { type: "thread.updated", threadId: "t1", patch: { provider: "claude" }, nativeSessionId: "c-1", updatedAt: 10 }),
    ]);
    expect(m.threads["t1"]?.providerSessions).toEqual({ claude: { nativeSessionId: "c-1", lastTurnId: "u1" }, codex: { nativeSessionId: "x-1", lastTurnId: "u2" } });
    expect(m.threads["t1"]?.nativeSessionId).toBe("c-1");
  });

  it("a recorded handoff is pending until the next turn carries it; delivery lands on the turn", () => {
    const handoff = { id: "h1", threadId: "t1", sourceThreadId: "t1", fromProvider: "claude" as const, toProvider: "codex" as const, strategy: "full" as const, coveredTurnIds: ["u1"], omittedTurnIds: [], text: "…", createdAt: 5 };
    const m = replay(base, [
      rec(5, { type: "turn.settled", turnId: "u1", threadId: "t1", status: "completed", settledAt: 5 }),
      rec(6, { type: "handoff.recorded", handoff }),
    ]);
    expect(m.threads["t1"]?.pendingHandoffId).toBe("h1");
    expect(m.handoffs["h1"]).toEqual(handoff);
    const m2 = replay(m, [
      rec(7, { type: "turn.requested", turn: { id: "u2", threadId: "t1", status: "requested", requestedAt: 7, handoffId: "h1" }, userMessage: { id: "m2", threadId: "t1", turnId: "u2", role: "user", text: "go", createdAt: 7 } }),
      rec(8, { type: "handoff.delivered", turnId: "u2", threadId: "t1", handoffId: "h1", delivery: "inline", at: 8 }),
    ]);
    expect(m2.threads["t1"]?.pendingHandoffId).toBeUndefined();
    expect(m2.turns["u2"]).toMatchObject({ handoffId: "h1", handoffDelivery: "inline" });
  });

  it("rollback marks the undone turns, points the thread at the survivor and clears attention", () => {
    const m = replay(base, [
      rec(5, { type: "turn.settled", turnId: "u1", threadId: "t1", status: "completed", settledAt: 5 }),
      rec(6, { type: "turn.requested", turn: { id: "u2", threadId: "t1", status: "requested", requestedAt: 6 }, userMessage: { id: "m2", threadId: "t1", turnId: "u2", role: "user", text: "plan", createdAt: 6 } }),
      rec(7, { type: "plan.proposed", plan: { id: "pl1", threadId: "t1", turnId: "u2", markdown: "# P", status: "proposed", createdAt: 7, updatedAt: 7 } }),
      rec(8, { type: "turn.settled", turnId: "u2", threadId: "t1", status: "completed", settledAt: 8 }),
      rec(9, { type: "rollback.requested", threadId: "t1", turnId: "u2", restoreFiles: false, turnIds: ["u2"], at: 9 }),
    ]);
    expect(m.threads["t1"]?.rollback?.status).toBe("rolling");
    expect(m.threads["t1"]?.attention).toBe("plan");
    const m2 = applyRecord(m, rec(10, { type: "rollback.completed", threadId: "t1", turnId: "u2", turnIds: ["u2"], at: 10 }));
    expect(m2.turns["u2"]?.rolledBack).toBe(true);
    expect(m2.turns["u1"]?.rolledBack).toBeUndefined();
    expect(m2.threads["t1"]).toMatchObject({ latestTurnId: "u1", rollback: { status: "done", turnId: "u2" } });
    // the plan belongs to a rolled-back turn: it no longer asks for the user
    expect(m2.threads["t1"]?.attention).toBeUndefined();
    const m3 = applyRecord(m, rec(10, { type: "rollback.failed", threadId: "t1", turnId: "u2", error: "boom", at: 10 }));
    expect(m3.threads["t1"]?.rollback).toMatchObject({ status: "error", error: "boom" });
  });

  it("limited / snoozed clear on resume; needing the user ends a snooze early", () => {
    const m = replay(base, [
      rec(5, { type: "turn.settled", turnId: "u1", threadId: "t1", status: "error", error: "limit", settledAt: 5 }),
      rec(6, { type: "thread.limited", threadId: "t1", limited: { resetsAt: 100, resume: "manual", at: 6 } }),
      rec(7, { type: "thread.limit-policy-changed", threadId: "t1", resume: "reset", at: 7 }),
      rec(8, { type: "thread.snoozed", threadId: "t1", until: 500, at: 8 }),
    ]);
    expect(m.threads["t1"]).toMatchObject({ limited: { resetsAt: 100, resume: "reset" }, snoozedUntil: 500 });
    const resumed = applyRecord(m, rec(9, { type: "thread.resumed", threadId: "t1", at: 9 }));
    expect(resumed.threads["t1"]?.limited).toBeUndefined();
    expect(resumed.threads["t1"]?.snoozedUntil).toBeUndefined();
    const woken = replay(m, [
      rec(9, { type: "turn.requested", turn: { id: "u2", threadId: "t1", status: "requested", requestedAt: 9 }, userMessage: { id: "m2", threadId: "t1", turnId: "u2", role: "user", text: "go", createdAt: 9 } }),
      rec(10, { type: "activity.upserted", activity: { id: "a1", kind: "user-input", threadId: "t1", turnId: "u2", requestId: "r1", questions: [{ id: "q", text: "?" }], status: "pending", createdAt: 10, updatedAt: 10 } }),
    ]);
    expect(woken.threads["t1"]?.attention).toBe("question");
    expect(woken.threads["t1"]?.snoozedUntil).toBeUndefined();
  });

  it("pr watch is recorded and stamped by each pr.updated", () => {
    const m = replay(base, [
      rec(5, { type: "pr.updated", threadId: "t1", pr: { url: "u", number: 1, state: "open", updatedAt: 5 } }),
      rec(6, { type: "pr.watch-changed", threadId: "t1", enabled: true, at: 6 }),
      rec(7, { type: "pr.updated", threadId: "t1", pr: { url: "u", number: 1, state: "open", updatedAt: 7, checks: "failure", comments: 2 } }),
    ]);
    expect(m.threads["t1"]?.prWatch).toEqual({ since: 6, lastCheckedAt: 7 });
    expect(m.threads["t1"]?.pr).toMatchObject({ checks: "failure", comments: 2 });
    expect(applyRecord(m, rec(8, { type: "pr.watch-changed", threadId: "t1", enabled: false, at: 8 })).threads["t1"]?.prWatch).toBeUndefined();
  });
});
