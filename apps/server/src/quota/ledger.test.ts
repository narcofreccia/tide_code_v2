import { describe, expect, it } from "vitest";
import type { Project, Quota, RateLimit, ReadModel } from "@tide/contracts";
import { modelWith, thread, turn } from "../usage/testing/fixtures.ts";
import { measureQuota, scopeThreads, shareWindows, WEEK_MS } from "./ledger.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const HOUR = 3_600_000;
const RESETS = NOW + 2 * 24 * HOUR;
const usd = (costUsd: number) => ({ inputTokens: 0, outputTokens: 0, costUsd });

function weekly(remainingPct: number, resetsAt = RESETS, windowMins?: number): RateLimit {
  return { status: "ok", remainingPct, resetsAt, window: "weekly", ...(windowMins !== undefined ? { windowMins } : {}), at: NOW };
}

function withProjects(model: ReadModel, ...ids: string[]): ReadModel {
  for (const id of ids) model.projects[id] = { id, title: id, rootPath: `/${id}`, createdAt: 0, updatedAt: 0 } as Project;
  return model;
}

function measure(model: ReadModel, quota: Quota, scope: "project" | "thread" = "project", id = "p1", outside?: Map<string, { usd: number; approx: boolean }>) {
  return measureQuota({ model, scope, id, quota, now: NOW, ...(outside ? { outside } : {}) });
}

describe("share cap", () => {
  it("is the instance's used share times the scope's part of Tide's spend", () => {
    const model = withProjects(
      modelWith([thread("a"), thread("b", { projectId: "p2" })], [turn("1", "a", NOW - HOUR, usd(30)), turn("2", "b", NOW - HOUR, usd(70))]),
      "p1",
      "p2",
    );
    model.limits = { claude: { weekly: weekly(60) } };
    // U = 40, P/T = 30/100 → share 12 of a 20 cap
    const state = measure(model, { sharePct: 20, onExceed: "hold" });
    expect(state).toMatchObject({ status: "ok", usedPct: 60, basis: "share", over: [], approx: true });
    expect(measure(model, { sharePct: 12, onExceed: "hold" })).toMatchObject({ status: "exceeded", over: ["claude"], windowEndsAt: RESETS });
    expect(measure(model, { sharePct: 15, onExceed: "hold" })).toMatchObject({ status: "warning", usedPct: 80 });
  });

  it("adds the harness's own logs to the instance's total", () => {
    const model = withProjects(modelWith([thread("a")], [turn("1", "a", NOW - HOUR, usd(30))]), "p1");
    model.limits = { claude: { weekly: weekly(60) } };
    // alone: share = 40; with 90 spent outside Tide: 40 × 30/120 = 10
    expect(measure(model, { sharePct: 20, onExceed: "hold" }).status).toBe("exceeded");
    const state = measure(model, { sharePct: 20, onExceed: "hold" }, "project", "p1", new Map([["claude", { usd: 90, approx: false }]]));
    expect(state).toMatchObject({ status: "ok", usedPct: 50 });
  });

  it("counts only spend inside the gauge's window", () => {
    const start = RESETS - 300 * 60_000;
    const model = withProjects(modelWith([thread("a"), thread("b", { projectId: "p2" })], [turn("1", "a", start - HOUR, usd(100)), turn("2", "a", start + HOUR, usd(10)), turn("3", "b", start + 2 * HOUR, usd(10))]), "p1", "p2");
    model.limits = { claude: { weekly: weekly(50, RESETS, 300) } };
    expect(shareWindows(model, NOW)[0]).toMatchObject({ since: start, until: RESETS, usedPct: 50 });
    // U = 50 × 10/20
    expect(measure(model, { sharePct: 50, onExceed: "warn" }).usedPct).toBe(50);
  });

  it("knows nothing about a window that has already reset", () => {
    const model = withProjects(modelWith([thread("a")], [turn("1", "a", NOW - 3 * 24 * HOUR, usd(30))]), "p1");
    model.limits = { claude: { weekly: weekly(1, NOW - HOUR) } };
    expect(shareWindows(model, NOW)[0]?.usedPct).toBe(0);
    expect(measure(model, { sharePct: 5, onExceed: "hold" })).toMatchObject({ status: "ok", usedPct: 0, over: [] });
  });

  it("does not measure harnesses without a weekly gauge", () => {
    const model = withProjects(modelWith([thread("a", { provider: "opencode" })], [turn("1", "a", NOW, usd(500), { provider: "opencode" })]), "p1");
    model.limits = { opencode: { session: { status: "ok", remainingPct: 1, resetsAt: RESETS, window: "session", at: NOW } } };
    expect(measure(model, { sharePct: 1, onExceed: "hold" })).toMatchObject({ status: "ok", usedPct: 0 });
  });

  it("files each turn under its own instance", () => {
    const model = withProjects(modelWith([thread("a")], [turn("1", "a", NOW, usd(10), { provider: "claude", providerId: "work" }), turn("2", "a", NOW, usd(10), { provider: "claude" })]), "p1");
    model.limits = { work: { weekly: weekly(10) }, claude: { weekly: weekly(70) } };
    const state = measure(model, { sharePct: 50, onExceed: "hold" });
    // work: 90, claude: 30 (the scope is all of each instance's Tide spend)
    expect(state.over).toEqual(["work"]);
    expect(state.usedPct).toBe(180);
  });
});

describe("scopes", () => {
  it("a project counts a delegate that lives in another project", () => {
    const model = withProjects(
      modelWith(
        [thread("root"), thread("delegate", { projectId: "p2", delegatedBy: "root" }), thread("other", { projectId: "p2" })],
        [turn("1", "root", NOW, usd(1)), turn("2", "delegate", NOW, usd(2)), turn("3", "other", NOW, usd(4))],
      ),
      "p1",
      "p2",
    );
    expect([...scopeThreads(model, "project", "p1")].sort()).toEqual(["delegate", "root"]);
    expect(measure(model, { usdPerWeek: 10, onExceed: "warn" }).usedPct).toBe(30);
    expect(measure(model, { usdPerWeek: 10, onExceed: "warn" }, "project", "p2").usedPct).toBe(40);
  });

  it("a thread counts its descendants, not its parent or siblings", () => {
    const model = withProjects(
      modelWith(
        [thread("parent"), thread("t", { parentThreadId: "parent" }), thread("child", { parentThreadId: "t" }), thread("grand", { delegatedBy: "child" }), thread("sibling", { parentThreadId: "parent" })],
        [turn("1", "parent", NOW, usd(100)), turn("2", "t", NOW, usd(1)), turn("3", "child", NOW, usd(2)), turn("4", "grand", NOW, usd(3)), turn("5", "sibling", NOW, usd(100))],
      ),
      "p1",
    );
    expect(measure(model, { usdPerWeek: 10, onExceed: "hold" }, "thread", "t").usedPct).toBe(60);
  });
});

describe("usd cap", () => {
  it("is a rolling seven days over every instance", () => {
    const model = withProjects(
      modelWith([thread("a")], [turn("old", "a", NOW - WEEK_MS - 1, usd(1000)), turn("1", "a", NOW - HOUR, usd(6), { provider: "codex" }), turn("2", "a", NOW - 6 * 24 * HOUR, usd(4))]),
      "p1",
    );
    const state = measure(model, { usdPerWeek: 10, onExceed: "hold" });
    expect(state).toMatchObject({ status: "exceeded", basis: "usd", usedPct: 100, over: ["*"] });
    expect(state.windowEndsAt).toBeUndefined();
    expect(state.approx).toBeUndefined();
  });

  it("uses the price table when no cost was reported, and says it is approximate", () => {
    const model = withProjects(modelWith([thread("a")], [turn("1", "a", NOW, { inputTokens: 1_000_000, outputTokens: 0 }, { model: "claude-sonnet-5-5" })]), "p1");
    expect(measure(model, { usdPerWeek: 4, onExceed: "warn" })).toMatchObject({ usedPct: 50, approx: true, status: "ok" });
  });

  it("thresholds: warning from 80%, exceeded at 100%", () => {
    const model = (cost: number) => withProjects(modelWith([thread("a")], [turn("1", "a", NOW, usd(cost))]), "p1");
    expect(measure(model(7.9), { usdPerWeek: 10, onExceed: "warn" }).status).toBe("ok");
    expect(measure(model(8), { usdPerWeek: 10, onExceed: "warn" }).status).toBe("warning");
    expect(measure(model(10), { usdPerWeek: 10, onExceed: "warn" }).status).toBe("exceeded");
  });
});

describe("both caps", () => {
  it("reports the worse one and every instance that is over", () => {
    const model = withProjects(modelWith([thread("a")], [turn("1", "a", NOW, usd(9))]), "p1");
    model.limits = { claude: { weekly: weekly(70) } };
    // share 30 of 20 (150%) beats 9 of 10 (90%)
    expect(measure(model, { sharePct: 20, usdPerWeek: 10, onExceed: "hold" })).toMatchObject({ basis: "share", usedPct: 150, over: ["claude"], windowEndsAt: RESETS, approx: true });
    // share 30 of 60 (50%) loses to 90%
    expect(measure(model, { sharePct: 60, usdPerWeek: 10, onExceed: "hold" })).toMatchObject({ basis: "usd", usedPct: 90, status: "warning", over: [] });
    // both over: the rolling cap has no window end
    const both = measure(model, { sharePct: 20, usdPerWeek: 5, onExceed: "hold" });
    expect(both.over).toEqual(["*", "claude"]);
    expect(both.windowEndsAt).toBeUndefined();
  });
});
