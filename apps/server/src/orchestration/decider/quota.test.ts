import { describe, expect, it } from "vitest";
import type { QuotaState } from "@tide/contracts";
import { LIFT_WITHOUT_WINDOW_MS } from "./quota.ts";
import { ctx, eventOf, run, startTurn, tryRun, withThread } from "./r4.fixtures.ts";

/** `withThread` plus the id of the project it made. */
const withProject = (provider: Parameters<typeof withThread>[0] = "claude") => {
  const f = withThread(provider);
  return { ...f, projectId: f.model.threads[f.threadId]?.projectId ?? "" };
};
const exceeded = (extra: Partial<QuotaState> = {}): QuotaState => ({ status: "exceeded", usedPct: 110, basis: "share", over: ["claude"], at: ctx.now, ...extra });

describe("decide: quota.set", () => {
  it("sets a project quota, is idempotent, and removes it", () => {
    const f = withProject();
    const quota = { sharePct: 30, onExceed: "hold" as const };
    const set = run(f.model, { type: "quota.set", scope: "project", id: f.projectId, quota });
    expect(eventOf(set.events, "quota.changed")).toMatchObject({ scope: "project", id: f.projectId, quota, at: ctx.now });
    expect(set.model.projects[f.projectId]?.quota).toEqual(quota);
    expect(run(set.model, { type: "quota.set", scope: "project", id: f.projectId, quota }).events).toEqual([]);
    const removed = run(set.model, { type: "quota.set", scope: "project", id: f.projectId });
    expect(removed.model.projects[f.projectId]?.quota).toBeUndefined();
    expect(run(removed.model, { type: "quota.set", scope: "project", id: f.projectId }).events).toEqual([]);
  });

  it("sets a thread quota; refuses an unknown scope and a quota with no cap", () => {
    const f = withProject();
    const set = run(f.model, { type: "quota.set", scope: "thread", id: f.threadId, quota: { usdPerWeek: 5, onExceed: "warn" } });
    expect(set.model.threads[f.threadId]?.quota).toEqual({ usdPerWeek: 5, onExceed: "warn" });
    expect(tryRun(f.model, { type: "quota.set", scope: "thread", id: "nope", quota: { usdPerWeek: 5, onExceed: "warn" } })).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(tryRun(f.model, { type: "quota.set", scope: "project", id: f.projectId, quota: { onExceed: "hold" } })).toMatchObject({ ok: false, error: { code: "invalid-command" } });
  });
});

describe("decide: quota.meter / quota.lift", () => {
  const withQuota = () => {
    const f = withProject();
    return { ...f, model: run(f.model, { type: "quota.set", scope: "project", id: f.projectId, quota: { sharePct: 30, onExceed: "hold" } }).model };
  };

  it("records a measurement; one for a scope without a quota is dropped", () => {
    const f = withQuota();
    const metered = run(f.model, { type: "quota.meter", scope: "project", id: f.projectId, state: exceeded() });
    expect(metered.model.projects[f.projectId]?.quotaState).toMatchObject({ status: "exceeded", usedPct: 110 });
    expect(run(f.model, { type: "quota.meter", scope: "thread", id: f.threadId, state: exceeded() }).events).toEqual([]);
    expect(run(f.model, { type: "quota.meter", scope: "project", id: "gone", state: exceeded() }).events).toEqual([]);
  });

  it("lifts until the window ends, or for a day when the cap has no window; a lift outlives later measurements", () => {
    const f = withQuota();
    const windowEndsAt = 9_000_000; // well past the fixture clock, which moves with every command
    const windowed = run(f.model, { type: "quota.meter", scope: "project", id: f.projectId, state: exceeded({ windowEndsAt }) }).model;
    const lifted = run(windowed, { type: "quota.lift", scope: "project", id: f.projectId });
    expect(eventOf(lifted.events, "quota.lifted").until).toBe(windowEndsAt);
    const again = run(lifted.model, { type: "quota.meter", scope: "project", id: f.projectId, state: exceeded({ usedPct: 120, windowEndsAt }) });
    expect(again.model.projects[f.projectId]?.quotaState).toMatchObject({ usedPct: 120, liftedUntil: windowEndsAt });

    const usd = run(f.model, { type: "quota.meter", scope: "project", id: f.projectId, state: exceeded({ basis: "usd", over: ["*"] }) }).model;
    const usdLift = eventOf(run(usd, { type: "quota.lift", scope: "project", id: f.projectId }).events, "quota.lifted");
    expect(usdLift.until).toBe(usdLift.at + LIFT_WITHOUT_WINDOW_MS);
    const past = run(f.model, { type: "quota.meter", scope: "project", id: f.projectId, state: exceeded({ windowEndsAt: 1 }) }).model;
    const pastLift = eventOf(run(past, { type: "quota.lift", scope: "project", id: f.projectId }).events, "quota.lifted");
    expect(pastLift.until).toBe(pastLift.at + LIFT_WITHOUT_WINDOW_MS);
  });

  it("refuses a lift when nothing is held", () => {
    const f = withQuota();
    expect(tryRun(f.model, { type: "quota.lift", scope: "project", id: f.projectId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const ok = run(f.model, { type: "quota.meter", scope: "project", id: f.projectId, state: { status: "warning", usedPct: 85, basis: "share", over: [], at: ctx.now } }).model;
    expect(tryRun(ok, { type: "quota.lift", scope: "project", id: f.projectId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(tryRun(f.model, { type: "quota.lift", scope: "thread", id: "nope" })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});

describe("decide: usage.correct and the instance on usage reports", () => {
  it("corrects a turn's usage once", () => {
    const f = withThread();
    const { model, turnId } = startTurn(f.model, f.threadId, "go");
    const reported = run(model, { type: "usage.report", turnId, usage: { inputTokens: 1, outputTokens: 2, costUsd: 162.05 } }).model;
    const fixed = run(reported, { type: "usage.correct", turnId, usage: { inputTokens: 0, outputTokens: 0, costUsd: -157.24 }, reason: "resume baseline" });
    expect(fixed.model.turns[turnId]?.usage?.costUsd).toBeCloseTo(4.81);
    expect(fixed.model.threads[f.threadId]?.totalCostUsd).toBeCloseTo(4.81);
    expect(tryRun(fixed.model, { type: "usage.correct", turnId, usage: { inputTokens: 0, outputTokens: 0, costUsd: -1 }, reason: "again" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(tryRun(model, { type: "usage.correct", turnId: "nope", usage: { inputTokens: 0, outputTokens: 0 }, reason: "x" })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("stamps a usage report with the instance, so a windowed rate limit reaches the gauge", () => {
    const f = withThread("codex");
    const { model, turnId } = startTurn(f.model, f.threadId, "go");
    const out = run(model, { type: "usage.report", turnId, rateLimit: { status: "ok", remainingPct: 70, window: "weekly", at: ctx.now } });
    expect(eventOf(out.events, "usage.reported").providerId).toBe("codex");
    expect(out.model.limits?.["codex"]?.["weekly"]).toMatchObject({ remainingPct: 70 });
  });

  it("thread.limited keeps the window the harness named", () => {
    const f = withThread();
    const out = run(f.model, { type: "thread.limited", threadId: f.threadId, resetsAt: 5_000, window: "weekly" });
    expect(out.model.threads[f.threadId]?.limited).toMatchObject({ window: "weekly", resetsAt: 5_000, resume: "manual" });
  });
});
