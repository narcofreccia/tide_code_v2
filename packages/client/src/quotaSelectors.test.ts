import { describe, expect, it } from "vitest";
import { emptyReadModel, type Project, type QuotaState, type ReadModel, type Thread } from "@tide/contracts";
import {
  queueHoldText,
  quotaCapText,
  quotaHoldText,
  quotaView,
  selectHeldProjects,
  selectQuotaHold,
} from "./quotaSelectors.ts";
import { threadSendBlock } from "./sendBlock.ts";

const NOW = 1_000_000;

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

const project = (patch: Partial<Project> = {}): Project => ({
  id: "p1",
  title: "Side project",
  rootPath: "/p1",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const state = (patch: Partial<QuotaState> = {}): QuotaState => ({
  status: "exceeded",
  usedPct: 103,
  basis: "share",
  over: ["claude"],
  windowEndsAt: NOW + 2 * 86_400_000,
  at: NOW - 1,
  ...patch,
});

function build(p: Project, threads: Thread[]): ReadModel {
  const model = emptyReadModel();
  model.projects[p.id] = p;
  for (const t of threads) model.threads[t.id] = t;
  return model;
}

describe("quotaView", () => {
  it("phrases a share cap as a share of the weekly window", () => {
    const view = quotaView("project", project({ quota: { sharePct: 30, onExceed: "hold" }, quotaState: state({ status: "warning", usedPct: 40 }) }), NOW);
    expect(view?.figureText).toBe("≈ 12% of the weekly window, cap 30%");
    expect(view?.capText).toBe("cap 30% of the weekly window");
    expect(view?.status).toBe("warning");
    expect(view?.holding).toBe(false);
  });

  it("phrases a USD cap as an amount this week", () => {
    const view = quotaView("project", project({ quota: { usdPerWeek: 20, onExceed: "warn" }, quotaState: state({ status: "ok", usedPct: 55, basis: "usd", over: [] }) }), NOW);
    expect(view?.figureText).toBe("≈ $11.00 of $20.00 this week");
    expect(quotaCapText({ sharePct: 30, usdPerWeek: 20, onExceed: "hold" })).toBe("cap 30% of the weekly window, $20.00 a week");
  });

  it("says measuring while the server has not measured the new cap", () => {
    const view = quotaView("project", project({ quota: { sharePct: 30, onExceed: "hold" } }), NOW);
    expect(view).toMatchObject({ status: "measuring", holding: false });
    expect(view?.figureText).toBeUndefined();
    expect(quotaView("project", project(), NOW)).toBeUndefined();
  });

  it("holds while exceeded with the hold policy, until the window ends or a lift", () => {
    const quota = { sharePct: 30, onExceed: "hold" as const };
    expect(quotaView("project", project({ quota, quotaState: state() }), NOW)).toMatchObject({ holding: true, resetsAt: NOW + 2 * 86_400_000 });
    expect(quotaView("project", project({ quota, quotaState: state({ windowEndsAt: NOW - 1 }) }), NOW)?.holding).toBe(false);
    const lifted = quotaView("project", project({ quota, quotaState: state({ liftedUntil: NOW + 10 }) }), NOW);
    expect(lifted).toMatchObject({ holding: false, liftedUntil: NOW + 10 });
    expect(quotaView("project", project({ quota, quotaState: state({ liftedUntil: NOW - 10 }) }), NOW)?.liftedUntil).toBeUndefined();
    expect(quotaView("project", project({ quota: { ...quota, onExceed: "warn" }, quotaState: state() }), NOW)?.holding).toBe(false);
  });
});

describe("quota holds", () => {
  const held = project({ quota: { sharePct: 30, onExceed: "hold" }, quotaState: state({ usedPct: 103.4 }) });

  it("names the project that holds a thread, through its root", () => {
    const model = build(held, [thread("root"), thread("child", { parentThreadId: "root" }), thread("codex", { provider: "codex" })]);
    const child = model.threads.child as Thread;
    const view = selectQuotaHold(model, child, NOW);
    expect(view).toMatchObject({ scope: "project", id: "p1", title: "Side project" });
    expect(quotaHoldText(view!)).toBe("Project quota reached (≈ 31% of the weekly window, cap 30%)");
    // the share cap is per instance: a codex thread is not over it
    expect(selectQuotaHold(model, model.threads.codex as Thread, NOW)).toBeUndefined();
  });

  it("gives the composer a quota block with the scope and reset", () => {
    const model = build(held, [thread("t1")]);
    const block = threadSendBlock(model.threads.t1 as Thread, { model, now: NOW });
    expect(block).toMatchObject({ kind: "quota", reason: "Project quota reached (≈ 31% of the weekly window, cap 30%).", continueElsewhere: false });
    expect(block?.quota?.resetsAt).toBe(NOW + 2 * 86_400_000);
    // without the model only the thread-level refusals are mirrored
    expect(threadSendBlock(model.threads.t1 as Thread)).toBeUndefined();
  });

  it("a thread's own quota wins over its project's", () => {
    const own = thread("t1", { title: "Mine", quota: { usdPerWeek: 5, onExceed: "hold" }, quotaState: state({ basis: "usd", usedPct: 100, over: ["*"] }) });
    const model = build(held, [own]);
    expect(threadSendBlock(own, { model, now: NOW })?.reason).toBe("Thread quota reached (≈ $5.00 of $5.00 this week).");
  });

  it("lists held projects with the threads they hold", () => {
    const model = build(held, [thread("a"), thread("b", { archivedAt: 5 }), thread("c", { provider: "codex" })]);
    const rows = selectHeldProjects(model, undefined, NOW);
    expect(rows.map((r) => [r.view.id, r.threads.map((t) => t.id)])).toEqual([["p1", ["a"]]]);
    expect(selectHeldProjects(model, ["other"], NOW)).toEqual([]);
    expect(selectHeldProjects(build(project(), [thread("a")]), undefined, NOW)).toEqual([]);
  });

  it("labels the queue of an idle held thread", () => {
    const model = build(held, [thread("a"), thread("r", { status: "running" }), thread("l", { limited: { resume: "manual", at: 1 } })]);
    expect(queueHoldText(model, model.threads.a as Thread, NOW)).toBe("Held by quota");
    expect(queueHoldText(model, model.threads.r as Thread, NOW)).toBeUndefined();
    expect(queueHoldText(model, model.threads.l as Thread, NOW)).toBe("Held until the limit resets");
    expect(queueHoldText(build(project(), [thread("a")]), thread("a"), NOW)).toBeUndefined();
  });
});
