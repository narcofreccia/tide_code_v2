import { describe, it, expect } from "vitest";
import { applyRecord, emptyReadModel, limitPhase, quotaBlock, replay, rootThread, type EventRecord, type Quota, type QuotaState, type ReadModel, type Thread } from "./index.ts";

const rec = (seq: number, event: EventRecord["event"]): EventRecord => ({ seq, ts: seq, event });
const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({ id, projectId: "p1", title: id, provider: "claude", mode: "approval-required", interaction: "default", status: "idle", createdAt: 2, updatedAt: 2, ...extra });
const turn = (seq: number, id: string, threadId: string, status: "requested" | "queued" = "requested"): EventRecord =>
  rec(seq, { type: "turn.requested", turn: { id, threadId, status, requestedAt: seq }, userMessage: { id: `m-${id}`, threadId, turnId: id, role: "user", text: id, createdAt: seq } });

const base = replay(emptyReadModel(), [
  rec(1, { type: "project.created", project: { id: "p1", title: "Side", rootPath: "/x", createdAt: 1, updatedAt: 1 } }),
  rec(2, { type: "thread.created", thread: thread("t1") }),
  turn(3, "u1", "t1"),
]);
const exceeded = (extra: Partial<QuotaState> = {}): QuotaState => ({ status: "exceeded", usedPct: 104, basis: "share", over: ["claude"], windowEndsAt: 1_000, at: 10, ...extra });

describe("projection: usage and limit gauges (R20)", () => {
  it("files a windowed rate limit under the instance and keeps the thread's last report", () => {
    const m = replay(base, [
      rec(4, { type: "usage.reported", turnId: "u1", threadId: "t1", providerId: "claude", rateLimit: { status: "ok", remainingPct: 82, window: "session", windowMins: 300, at: 4 }, at: 4 }),
      rec(5, { type: "usage.reported", turnId: "u1", threadId: "t1", providerId: "claude", rateLimit: { status: "warning", remainingPct: 9, window: "weekly", windowMins: 10080, resetsAt: 900, at: 5 }, at: 5 }),
      rec(6, { type: "usage.reported", turnId: "u1", threadId: "t1", providerId: "claude", rateLimit: { status: "warning", note: "overage", at: 6 }, at: 6 }),
      rec(7, { type: "usage.reported", turnId: "u1", threadId: "t1", rateLimit: { status: "limited", window: "weekly", at: 7 }, at: 7 }),
    ]);
    expect(m.limits?.["claude"]?.["session"]).toMatchObject({ remainingPct: 82 });
    // a report without a window (seq 6) or without an instance (seq 7) never reaches the gauge
    expect(m.limits?.["claude"]?.["weekly"]).toMatchObject({ status: "warning", remainingPct: 9, resetsAt: 900 });
    expect(m.threads["t1"]?.rateLimit).toMatchObject({ status: "limited" });
    expect(base.limits).toBeUndefined();
  });

  it("usage.corrected takes cost back from the turn and the thread, once marked, without touching updatedAt", () => {
    const reported = replay(base, [
      rec(4, { type: "usage.reported", turnId: "u1", threadId: "t1", usage: { inputTokens: 6, outputTokens: 700, costUsd: 162.05 }, at: 4 }),
    ]);
    const m = applyRecord(reported, rec(5, { type: "usage.corrected", turnId: "u1", threadId: "t1", usage: { inputTokens: 0, outputTokens: 0, costUsd: -157.24 }, reason: "resume baseline", at: 99 }));
    expect(m.turns["u1"]?.usage?.costUsd).toBeCloseTo(4.81);
    expect(m.turns["u1"]?.usage?.outputTokens).toBe(700);
    expect(m.turns["u1"]?.usageCorrected).toBe(true);
    expect(m.threads["t1"]?.totalCostUsd).toBeCloseTo(4.81);
    expect(m.threads["t1"]?.updatedAt).toBe(reported.threads["t1"]?.updatedAt);
    const over = applyRecord(reported, rec(5, { type: "usage.corrected", turnId: "u1", threadId: "t1", usage: { inputTokens: 0, outputTokens: 0, costUsd: -500 }, reason: "x", at: 99 }));
    expect(over.threads["t1"]?.totalCostUsd).toBe(0);
    expect(applyRecord(reported, rec(5, { type: "usage.corrected", turnId: "nope", threadId: "t1", usage: { inputTokens: 0, outputTokens: 0 }, reason: "x", at: 99 }))).toMatchObject({ turns: reported.turns });
  });
});

describe("projection: quotas (R20)", () => {
  const quota = { sharePct: 30, onExceed: "hold" as const };

  it("sets, meters, lifts and removes a project quota", () => {
    let m = applyRecord(base, rec(4, { type: "quota.changed", scope: "project", id: "p1", quota, at: 4 }));
    expect(m.projects["p1"]).toMatchObject({ quota, updatedAt: 4 });
    expect(m.projects["p1"]?.quotaState).toBeUndefined();
    m = applyRecord(m, rec(5, { type: "quota.metered", scope: "project", id: "p1", state: exceeded() }));
    expect(m.projects["p1"]?.quotaState).toMatchObject({ status: "exceeded", usedPct: 104 });
    expect(m.projects["p1"]?.updatedAt).toBe(4);
    m = applyRecord(m, rec(6, { type: "quota.lifted", scope: "project", id: "p1", until: 1_000, at: 6 }));
    expect(m.projects["p1"]?.quotaState?.liftedUntil).toBe(1_000);
    // a new cap drops the measurement taken against the old one
    const raised = applyRecord(m, rec(7, { type: "quota.changed", scope: "project", id: "p1", quota: { ...quota, sharePct: 50 }, at: 7 }));
    expect(raised.projects["p1"]?.quota?.sharePct).toBe(50);
    expect(raised.projects["p1"]?.quotaState).toBeUndefined();
    const removed = applyRecord(m, rec(7, { type: "quota.changed", scope: "project", id: "p1", at: 7 }));
    expect(removed.projects["p1"]?.quota).toBeUndefined();
    expect(removed.projects["p1"]?.quotaState).toBeUndefined();
  });

  it("a thread quota does not bump the thread; a measurement without a quota is dropped", () => {
    const m = applyRecord(base, rec(4, { type: "quota.changed", scope: "thread", id: "t1", quota: { usdPerWeek: 5, onExceed: "warn" }, at: 50 }));
    expect(m.threads["t1"]?.quota).toEqual({ usdPerWeek: 5, onExceed: "warn" });
    expect(m.threads["t1"]?.updatedAt).toBe(base.threads["t1"]?.updatedAt);
    const stray = applyRecord(base, rec(4, { type: "quota.metered", scope: "thread", id: "t1", state: exceeded() }));
    expect(stray.threads["t1"]?.quotaState).toBeUndefined();
    expect(applyRecord(base, rec(4, { type: "quota.lifted", scope: "thread", id: "t1", until: 9, at: 4 })).threads).toEqual(base.threads);
    expect(applyRecord(base, rec(4, { type: "quota.changed", scope: "thread", id: "missing", quota, at: 4 })).threads).toEqual(base.threads);
  });

  it("holdQueue leaves the thread idle with its queue; turn.released starts the queued turn", () => {
    const queued = replay(base, [turn(4, "u2", "t1", "queued"), turn(5, "u3", "t1", "queued")]);
    const promoted = applyRecord(queued, rec(6, { type: "turn.settled", turnId: "u1", threadId: "t1", status: "completed", settledAt: 6 }));
    expect(promoted.threads["t1"]).toMatchObject({ status: "running", latestTurnId: "u2" });
    const held = applyRecord(queued, rec(6, { type: "turn.settled", turnId: "u1", threadId: "t1", status: "completed", holdQueue: true, settledAt: 6 }));
    expect(held.threads["t1"]).toMatchObject({ status: "idle", latestTurnId: "u1" });
    expect(held.turns["u2"]?.status).toBe("queued");
    const settled = applyRecord(held, rec(7, { type: "thread.settled", threadId: "t1", reason: "user", at: 7 }));
    const released = applyRecord(settled, rec(8, { type: "turn.released", threadId: "t1", turnId: "u2", at: 8 }));
    expect(released.threads["t1"]).toMatchObject({ status: "running", latestTurnId: "u2", updatedAt: 8 });
    expect(released.threads["t1"]?.settledAt).toBeUndefined();
    expect(released.turns["u2"]?.status).toBe("requested");
    expect(released.turns["u3"]?.status).toBe("queued");
    // nothing to release: the thread is running, the turn is not queued, or it belongs elsewhere
    expect(applyRecord(released, rec(9, { type: "turn.released", threadId: "t1", turnId: "u3", at: 9 })).turns["u3"]?.status).toBe("queued");
    expect(applyRecord(held, rec(7, { type: "turn.released", threadId: "t1", turnId: "u1", at: 7 })).threads).toEqual(held.threads);
  });
});

describe("quotaBlock", () => {
  const quota: Quota = { sharePct: 30, onExceed: "hold" };
  const withProject = (state: QuotaState, q: Quota = quota, threads: Thread[] = [thread("t1")]): ReadModel => ({
    ...base,
    projects: { p1: { ...base.projects["p1"]!, quota: q, quotaState: state }, p2: { id: "p2", title: "Main", rootPath: "/y", createdAt: 1, updatedAt: 1 } },
    threads: Object.fromEntries(threads.map((t) => [t.id, t])),
  });

  it("holds a thread of an exceeded project until the window ends or the hold is lifted", () => {
    const m = withProject(exceeded());
    expect(quotaBlock(m, m.threads["t1"]!, 500)).toMatchObject({ scope: "project", id: "p1" });
    expect(quotaBlock(m, m.threads["t1"]!, 1_000)).toBeUndefined();
    const lifted = withProject(exceeded({ liftedUntil: 800 }));
    expect(quotaBlock(lifted, lifted.threads["t1"]!, 500)).toBeUndefined();
    expect(quotaBlock(lifted, lifted.threads["t1"]!, 800)).toMatchObject({ scope: "project" });
  });

  it("does not hold on warn, on a state short of exceeded, or for an instance that is not over", () => {
    const warn = withProject(exceeded(), { sharePct: 30, onExceed: "warn" });
    expect(quotaBlock(warn, warn.threads["t1"]!, 500)).toBeUndefined();
    const warning = withProject(exceeded({ status: "warning", usedPct: 85, over: [] }));
    expect(quotaBlock(warning, warning.threads["t1"]!, 500)).toBeUndefined();
    const codex = withProject(exceeded(), quota, [thread("t1", { provider: "codex" }), thread("t2", { providerId: "claude-work" })]);
    expect(quotaBlock(codex, codex.threads["t1"]!, 500)).toBeUndefined();
    expect(quotaBlock(codex, codex.threads["t2"]!, 500)).toBeUndefined();
    const usd = withProject({ status: "exceeded", usedPct: 104, basis: "usd", over: ["*"], at: 10 }, quota, [thread("t1", { provider: "codex" })]);
    expect(quotaBlock(usd, usd.threads["t1"]!, 9e12)).toMatchObject({ scope: "project" });
  });

  it("counts a delegate in another project against the project its lineage started in", () => {
    const m = withProject(exceeded(), quota, [thread("t1"), thread("d1", { projectId: "p2", delegatedBy: "t1", role: "delegate" }), thread("s1", { projectId: "p2", parentThreadId: "d1", role: "side" }), thread("other", { projectId: "p2" })]);
    expect(rootThread(m, m.threads["s1"]!).id).toBe("t1");
    expect(quotaBlock(m, m.threads["d1"]!, 500)).toMatchObject({ scope: "project", id: "p1" });
    expect(quotaBlock(m, m.threads["s1"]!, 500)).toMatchObject({ scope: "project", id: "p1" });
    expect(quotaBlock(m, m.threads["other"]!, 500)).toBeUndefined();
  });

  it("a thread's own quota holds it and its descendants; the nearest scope wins; a lineage cycle ends the walk", () => {
    const own = { quota: { usdPerWeek: 2, onExceed: "hold" as const }, quotaState: exceeded({ basis: "usd", over: ["*"] }) };
    const m = withProject({ status: "ok", usedPct: 10, basis: "share", over: [], at: 1 }, quota, [thread("t1", own), thread("d1", { delegatedBy: "t1" }), thread("t2")]);
    expect(quotaBlock(m, m.threads["t1"]!, 500)).toMatchObject({ scope: "thread", id: "t1" });
    expect(quotaBlock(m, m.threads["d1"]!, 500)).toMatchObject({ scope: "thread", id: "t1" });
    expect(quotaBlock(m, m.threads["t2"]!, 500)).toBeUndefined();
    const cycle = withProject(exceeded(), quota, [thread("a", { parentThreadId: "b" }), thread("b", { parentThreadId: "a" })]);
    expect(quotaBlock(cycle, cycle.threads["a"]!, 500)).toMatchObject({ scope: "project", id: "p1" });
  });
});

describe("limitPhase", () => {
  const limitedThread = (limited: NonNullable<Thread["limited"]>): Thread => thread("t1", { limited });
  const model = (t: Thread, limits?: ReadModel["limits"]): ReadModel => ({ ...base, threads: { t1: t }, ...(limits ? { limits } : {}) });

  it("is undefined for a thread that is not limited", () => {
    expect(limitPhase(base, base.threads["t1"]!, 5)).toBeUndefined();
  });

  it("waits for a known reset and is ready once it has passed", () => {
    const t = limitedThread({ resetsAt: 100, resume: "manual", at: 10 });
    expect(limitPhase(model(t), t, 99)).toBe("waiting");
    expect(limitPhase(model(t), t, 100)).toBe("ready");
  });

  it("is ready when the account's window answered open after the thread was parked", () => {
    const t = limitedThread({ resetsAt: 100, resume: "manual", window: "weekly", at: 10 });
    const open = (at: number, status: "ok" | "limited" = "ok") => ({ status, at });
    expect(limitPhase(model(t, { claude: { weekly: open(20) } }), t, 50)).toBe("ready");
    expect(limitPhase(model(t, { claude: { weekly: open(5) } }), t, 50)).toBe("waiting");
    expect(limitPhase(model(t, { claude: { weekly: open(20, "limited") } }), t, 50)).toBe("waiting");
    // the short window answering says nothing about the weekly one, nor does another account
    expect(limitPhase(model(t, { claude: { session: open(20) } }), t, 50)).toBe("waiting");
    expect(limitPhase(model(t, { "claude-work": { weekly: open(20) } }), t, 50)).toBe("waiting");
  });

  it("without a reset time or a window it is unknown until every window heard since is open", () => {
    const t = limitedThread({ resume: "reset", at: 10 });
    expect(limitPhase(model(t), t, 9e12)).toBe("unknown");
    expect(limitPhase(model(t, { claude: { session: { status: "ok", at: 20 }, weekly: { status: "limited", at: 21 } } }), t, 50)).toBe("unknown");
    expect(limitPhase(model(t, { claude: { session: { status: "ok", at: 20 }, weekly: { status: "ok", at: 5 } } }), t, 50)).toBe("ready");
  });
});
