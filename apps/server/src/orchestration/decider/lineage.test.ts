import { describe, expect, it } from "vitest";
import type { ReadModel } from "@tide/contracts";
import { completeTurn, ctx, eventOf, run, startTurn, tryRun, withThread } from "./r4.fixtures.ts";

/** A claude thread with two settled turns. */
function withHistory(worktree = false) {
  const base = withThread("claude", worktree);
  const t1 = completeTurn(base.model, base.threadId, "fix the login form", "patched login.ts", "claude-sess");
  const t2 = completeTurn(t1.model, base.threadId, "now add a test for it", "added login.test.ts");
  return { model: t2.model, threadId: base.threadId, t1: t1.turnId, t2: t2.turnId };
}

describe("decide: thread.update provider switch", () => {
  it("full handoff to a harness that never ran the thread", () => {
    const h = withHistory();
    const { model, events } = run(h.model, { type: "thread.update", threadId: h.threadId, provider: "codex" });
    expect(eventOf(events, "thread.updated")).toMatchObject({ clearNativeSession: true, patch: { provider: "codex" } });
    const { handoff } = eventOf(events, "handoff.recorded");
    expect(handoff).toMatchObject({ threadId: h.threadId, sourceThreadId: h.threadId, fromProvider: "claude", toProvider: "codex", strategy: "full" });
    expect(handoff.coveredTurnIds).toEqual([h.t1, h.t2]);
    expect(handoff.text).toContain("now add a test for it");
    expect(model.threads[h.threadId]?.pendingHandoffId).toBe(handoff.id);
  });

  it("drops the old harness's model unless a new one is named", () => {
    const h = withHistory();
    const withModel = run(h.model, { type: "thread.update", threadId: h.threadId, model: "opus-9" }).model;
    expect(eventOf(run(withModel, { type: "thread.update", threadId: h.threadId, provider: "codex" }).events, "thread.updated")).toMatchObject({ clearModel: true });
    const named = eventOf(run(withModel, { type: "thread.update", threadId: h.threadId, provider: "codex", model: "gpt-x" }).events, "thread.updated");
    expect(named.clearModel).toBeUndefined();
    expect(named.patch.model).toBe("gpt-x");
  });

  it("delta handoff back to a harness that already ran it, keeping its session", () => {
    const h = withHistory();
    const toCodex = run(h.model, { type: "thread.update", threadId: h.threadId, provider: "codex" }).model;
    const t3 = completeTurn(toCodex, h.threadId, "rename the helper", "renamed", "codex-sess");
    const { model, events } = run(t3.model, { type: "thread.update", threadId: h.threadId, provider: "claude" });
    const updated = eventOf(events, "thread.updated");
    expect(updated.nativeSessionId).toBe("claude-sess");
    expect(updated.clearNativeSession).toBeUndefined();
    const { handoff } = eventOf(events, "handoff.recorded");
    expect(handoff.strategy).toBe("delta");
    expect(handoff.coveredTurnIds).toEqual([t3.turnId]);
    expect(handoff.text).toContain("rename the helper");
    expect(model.threads[h.threadId]?.nativeSessionId).toBe("claude-sess");
  });

  it("records no handoff for a thread without history, and is busy while running", () => {
    const base = withThread();
    const { events } = run(base.model, { type: "thread.update", threadId: base.threadId, provider: "pi" });
    expect(events.map((e) => e.type)).toEqual(["thread.updated"]);
    const live = startTurn(base.model, base.threadId, "go");
    expect(tryRun(live.model, { type: "thread.update", threadId: base.threadId, provider: "codex" })).toMatchObject({ ok: false, error: { code: "busy" } });
  });

  it("honours the handoff cap from the context", () => {
    const h = withHistory();
    const long = completeTurn(h.model, h.threadId, "x".repeat(3_000), "y".repeat(3_000));
    ctx.handoffCap = 1_024;
    try {
      const { handoff } = eventOf(run(long.model, { type: "thread.update", threadId: h.threadId, provider: "codex" }).events, "handoff.recorded");
      expect(handoff.omittedTurnIds.length).toBeGreaterThan(0);
    } finally {
      delete ctx.handoffCap;
    }
  });
});

describe("decide: thread.fork", () => {
  it("forks at a settled turn with a full handoff of the history up to it", () => {
    const h = withHistory(true);
    const { model, events } = run(h.model, { type: "thread.fork", threadId: h.threadId, turnId: h.t1, provider: "codex", useWorktree: true });
    const created = eventOf(events, "thread.created");
    expect(created.thread).toMatchObject({
      parentThreadId: h.threadId,
      forkedFrom: { threadId: h.threadId, turnId: h.t1 },
      title: "Login fix (fork)",
      provider: "codex",
      status: "idle",
    });
    expect(created.thread.model).toBeUndefined();
    expect(created.baseRef).toBe(`after-${h.t1}`);
    expect(created.useWorktree).toBe(true);
    const { handoff } = eventOf(events, "handoff.recorded");
    expect(handoff).toMatchObject({ threadId: created.thread.id, sourceThreadId: h.threadId, fromProvider: "claude", toProvider: "codex", strategy: "full", coveredTurnIds: [h.t1] });
    expect(handoff.text).toContain("fix the login form");
    expect(handoff.text).not.toContain("now add a test");
    expect(model.threads[created.thread.id]?.pendingHandoffId).toBe(handoff.id);
  });

  it("refuses an unsettled or unknown turn", () => {
    const h = withHistory();
    const live = startTurn(h.model, h.threadId, "more");
    expect(tryRun(live.model, { type: "thread.fork", threadId: h.threadId, turnId: live.turnId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(tryRun(h.model, { type: "thread.fork", threadId: h.threadId, turnId: "nope" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    const other = withHistory();
    expect(tryRun(other.model, { type: "thread.fork", threadId: other.threadId, turnId: h.t1 })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});

function rolling(model: ReadModel, threadId: string, turnId: string, restoreFiles = false) {
  return run(model, { type: "thread.rollback", threadId, turnId, restoreFiles });
}

describe("decide: thread.rollback", () => {
  it("rolls back a turn and everything after it", () => {
    const h = withHistory();
    const { model, events } = rolling(h.model, h.threadId, h.t1);
    expect(eventOf(events, "rollback.requested")).toMatchObject({ turnId: h.t1, restoreFiles: false, turnIds: [h.t1, h.t2] });
    expect(model.threads[h.threadId]?.rollback?.status).toBe("rolling");
    expect(tryRun(model, { type: "thread.rollback", threadId: h.threadId, turnId: h.t2, restoreFiles: false })).toMatchObject({ ok: false, error: { code: "busy" } });
  });

  it("restoring files needs a worktree and a before-checkpoint", () => {
    const h = withHistory();
    expect(tryRun(h.model, { type: "thread.rollback", threadId: h.threadId, turnId: h.t2, restoreFiles: true })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const w = withHistory(true);
    expect(eventOf(rolling(w.model, w.threadId, w.t2, true).events, "rollback.requested").turnIds).toEqual([w.t2]);
  });

  it("refuses while running, and on a rolled-back turn", () => {
    const h = withHistory();
    const live = startTurn(h.model, h.threadId, "more");
    expect(tryRun(live.model, { type: "thread.rollback", threadId: h.threadId, turnId: h.t1, restoreFiles: false })).toMatchObject({ ok: false, error: { code: "busy" } });
    const done = run(rolling(h.model, h.threadId, h.t2).model, { type: "rollback.report", threadId: h.threadId, outcome: "done" }).model;
    expect(tryRun(done, { type: "thread.rollback", threadId: h.threadId, turnId: h.t2, restoreFiles: false })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("a rolling thread refuses new turns, steers, forks and provider switches", () => {
    const h = withHistory();
    const { model } = rolling(h.model, h.threadId, h.t2);
    for (const command of [
      { type: "turn.request", threadId: h.threadId, text: "x" },
      { type: "turn.steer", threadId: h.threadId, text: "x" },
      { type: "thread.fork", threadId: h.threadId, turnId: h.t1 },
      { type: "thread.update", threadId: h.threadId, provider: "codex" },
    ] as const) {
      expect(tryRun(model, command), command.type).toMatchObject({ ok: false, error: { code: "busy" } });
    }
  });

  it("rolled-back turns follow log order, not requestedAt ties", () => {
    const h = withHistory();
    // two turns requested in the same millisecond: the later one in the log is the later turn
    ctx.now -= 10;
    const same = completeTurn(h.model, h.threadId, "same ms", "ok");
    const { events } = rolling(same.model, h.threadId, h.t2);
    expect(eventOf(events, "rollback.requested").turnIds).toEqual([h.t2, same.turnId]);
    expect(eventOf(rolling(same.model, h.threadId, same.turnId).events, "rollback.requested").turnIds).toEqual([same.turnId]);
  });

  it("completes and fails through rollback.report", () => {
    const h = withHistory();
    const started = rolling(h.model, h.threadId, h.t1).model;
    const done = run(started, { type: "rollback.report", threadId: h.threadId, outcome: "done" });
    expect(eventOf(done.events, "rollback.completed")).toMatchObject({ turnId: h.t1, turnIds: [h.t1, h.t2], provider: "claude" });
    const reminted = run(started, { type: "rollback.report", threadId: h.threadId, outcome: "done", nativeSessionId: "sess-2" });
    expect(reminted.model.threads[h.threadId]?.nativeSessionId).toBe("sess-2");
    expect(done.model.turns[h.t2]?.rolledBack).toBe(true);
    const failed = run(started, { type: "rollback.report", threadId: h.threadId, outcome: "error" });
    expect(eventOf(failed.events, "rollback.failed")).toMatchObject({ turnId: h.t1, error: "rollback failed" });
    expect(tryRun(h.model, { type: "rollback.report", threadId: h.threadId, outcome: "done" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("decide: limits, snooze, resume", () => {
  it("records a limit with the thread's resume policy", () => {
    const base = withThread();
    const limited = run(base.model, { type: "thread.limited", threadId: base.threadId, resetsAt: 5_000, note: "5h window" });
    expect(eventOf(limited.events, "thread.limited").limited).toMatchObject({ resetsAt: 5_000, note: "5h window", resume: "manual" });
    const policy = run(limited.model, { type: "thread.limit-policy", threadId: base.threadId, resume: "reset" });
    expect(policy.model.threads[base.threadId]?.limited?.resume).toBe("reset");
    const again = run(policy.model, { type: "thread.limited", threadId: base.threadId });
    expect(eventOf(again.events, "thread.limited").limited.resume).toBe("reset");
    expect(tryRun(base.model, { type: "thread.limited", threadId: "nope" })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("snoozes only into the future", () => {
    const base = withThread();
    const { model } = run(base.model, { type: "thread.snooze", threadId: base.threadId, until: ctx.now + 60_000 });
    expect(model.threads[base.threadId]?.snoozedUntil).toBeDefined();
    expect(tryRun(base.model, { type: "thread.snooze", threadId: base.threadId, until: 0 })).toMatchObject({ ok: false, error: { code: "invalid-command" } });
  });

  it("resumes a limited thread, optionally with a continuation turn", () => {
    const base = withThread();
    const limited = run(base.model, { type: "thread.limited", threadId: base.threadId }).model;
    const plain = run(limited, { type: "thread.resume", threadId: base.threadId });
    expect(plain.events.map((e) => e.type)).toEqual(["thread.resumed"]);
    expect(plain.model.threads[base.threadId]?.limited).toBeUndefined();
    const cont = run(limited, { type: "thread.resume", threadId: base.threadId, continue: true });
    expect(cont.events.map((e) => e.type)).toEqual(["thread.resumed", "turn.requested"]);
    expect(eventOf(cont.events, "turn.requested").userMessage).toMatchObject({ text: "Continue where you left off.", notification: { source: "restart", summary: "resumed by the user" } });
  });

  it("refuses a resume with nothing to do, or while running", () => {
    const base = withThread();
    expect(tryRun(base.model, { type: "thread.resume", threadId: base.threadId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(tryRun(base.model, { type: "thread.resume", threadId: base.threadId, continue: true }).ok).toBe(true);
    const live = startTurn(base.model, base.threadId, "go");
    expect(tryRun(live.model, { type: "thread.resume", threadId: base.threadId, continue: true })).toMatchObject({ ok: false, error: { code: "busy" } });
  });
});

describe("decide: pr.watch", () => {
  it("watches only a thread with a PR", () => {
    const base = withThread();
    expect(tryRun(base.model, { type: "pr.watch", threadId: base.threadId, enabled: true })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const withPr = run(base.model, { type: "pr.update", threadId: base.threadId, pr: { url: "https://x/pr/1", number: 1, state: "open", updatedAt: 1 } }).model;
    const { model } = run(withPr, { type: "pr.watch", threadId: base.threadId, enabled: true });
    expect(model.threads[base.threadId]?.prWatch).toBeDefined();
    expect(run(model, { type: "pr.watch", threadId: base.threadId, enabled: false }).model.threads[base.threadId]?.prWatch).toBeUndefined();
  });
});

describe("decide: thread.delegate role", () => {
  it("copies the role onto the delegate", () => {
    const base = withThread();
    const { events } = run(base.model, { type: "thread.delegate", fromThreadId: base.threadId, provider: "codex", prompt: "review it", role: "review" });
    expect(eventOf(events, "thread.created").thread.delegateRole).toBe("review");
  });
});
