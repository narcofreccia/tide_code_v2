import { describe, expect, it } from "vitest";
import type { Command, DomainEvent, EventRecord, Project, Quota, ReadModel } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import type { CancelTimer } from "../orchestration/limits.ts";
import { SettingsStore } from "../settings.ts";
import { modelWith, thread, turn } from "../usage/testing/fixtures.ts";
import { harnessLogSpend, meterChanged, QuotaWorker, type OutsideSpendFn } from "./worker.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const usd = (costUsd: number) => ({ inputTokens: 0, outputTokens: 0, costUsd });

/** The three engine calls the worker makes; `quota.meter` is applied the way the projector does. */
function fakeEngine(model: ReadModel) {
  const dispatched: Command[] = [];
  const listeners = new Set<(r: EventRecord) => void>();
  let seq = 0;
  const engine = {
    getModel: () => model,
    subscribe: (fn: (r: EventRecord) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispatch: async (command: Command) => {
      dispatched.push(command);
      if (command.type === "quota.meter") {
        const entity = command.scope === "project" ? model.projects[command.id] : model.threads[command.id];
        if (entity) entity.quotaState = command.state;
      }
      return { seq: ++seq, events: [] };
    },
  } as unknown as Engine;
  const emit = (event: DomainEvent): void => {
    for (const fn of listeners) fn({ seq: ++seq, ts: NOW, event });
  };
  return { engine, dispatched, emit };
}

function setup(quota: Quota | undefined, cost = 5) {
  const model = modelWith([thread("a")], [turn("1", "a", NOW - 1000, usd(cost))]);
  model.projects["p1"] = { id: "p1", title: "p", rootPath: "/p", createdAt: 0, updatedAt: 0, ...(quota ? { quota } : {}) } as Project;
  const clock = { now: NOW };
  const fake = fakeEngine(model);
  return { ...fake, model, clock, worker: new QuotaWorker({ engine: fake.engine, now: () => clock.now }) };
}

const addCost = (model: ReadModel, id: string, cost: number, at = NOW): void => {
  model.turns[id] = turn(id, "a", at, usd(cost));
};

describe("QuotaWorker.tick", () => {
  it("does nothing without a quota and never reads the harness logs", async () => {
    const model = modelWith([thread("a")], [turn("1", "a", NOW, usd(5))]);
    const { engine, dispatched } = fakeEngine(model);
    let scans = 0;
    const outside: OutsideSpendFn = async () => {
      scans++;
      return { usd: 0, approx: false };
    };
    const settings = new SettingsStore();
    const worker = new QuotaWorker({ engine, outside, settings, now: () => NOW });
    expect(await worker.tick()).toBe(0);
    expect(scans).toBe(0);
    expect(dispatched).toEqual([]);
  });

  it("records the first measurement, then only a change or a 5-point step", async () => {
    const { worker, dispatched, model } = setup({ usdPerWeek: 100, onExceed: "hold" });
    expect(await worker.tick()).toBe(1);
    expect(dispatched[0]).toMatchObject({ type: "quota.meter", scope: "project", id: "p1", state: { status: "ok", usedPct: 5, basis: "usd", over: [] } });
    addCost(model, "2", 4); // 9%: same 5-point step
    expect(await worker.tick()).toBe(0);
    addCost(model, "3", 1); // 10%
    expect(await worker.tick()).toBe(1);
    addCost(model, "4", 75); // 85%: warning
    expect(await worker.tick()).toBe(1);
    expect(model.projects["p1"]?.quotaState).toMatchObject({ status: "warning", usedPct: 85 });
    addCost(model, "5", 20); // over
    expect(await worker.tick()).toBe(1);
    expect(model.projects["p1"]?.quotaState).toMatchObject({ status: "exceeded", over: ["*"] });
    expect(await worker.tick()).toBe(0);
  });

  it("measures again once a stored window end has passed", async () => {
    const { worker, dispatched, model, clock } = setup({ sharePct: 10, onExceed: "hold" });
    model.limits = { claude: { weekly: { status: "ok", remainingPct: 50, resetsAt: NOW + 60_000, window: "weekly", at: NOW } } };
    expect(await worker.tick()).toBe(1);
    expect(model.projects["p1"]?.quotaState).toMatchObject({ status: "exceeded", over: ["claude"], windowEndsAt: NOW + 60_000 });
    expect(await worker.tick()).toBe(0);
    clock.now = NOW + 60_000;
    expect(await worker.tick()).toBe(1);
    expect(dispatched.at(-1)).toMatchObject({ state: { status: "ok", over: [] } });
  });

  it("adds harness-log spend for a kind's default instance only when the setting allows it", async () => {
    const { engine, model } = setup({ sharePct: 30, onExceed: "hold" });
    model.limits = {
      claude: { weekly: { status: "ok", remainingPct: 50, resetsAt: NOW + 3_600_000, window: "weekly", at: NOW } },
      work: { weekly: { status: "ok", remainingPct: 50, resetsAt: NOW + 3_600_000, window: "weekly", at: NOW } },
    };
    const asked: string[] = [];
    const outside: OutsideSpendFn = async (kind) => {
      asked.push(kind);
      return { usd: 15, approx: false };
    };
    const settings = new SettingsStore();
    settings.set({ glassBox: { readHarnessLogs: false } });
    const off = new QuotaWorker({ engine, outside, settings, now: () => NOW });
    await off.tick();
    expect(asked).toEqual([]);
    expect(model.projects["p1"]?.quotaState?.status).toBe("exceeded"); // 50 of 30
    settings.set({ glassBox: { readHarnessLogs: true } });
    const on = new QuotaWorker({ engine, outside, settings, now: () => NOW });
    await on.tick();
    expect(asked).toEqual(["claude"]);
    // 50 × 5/20 = 12.5 of 30
    expect(model.projects["p1"]?.quotaState).toMatchObject({ status: "ok", usedPct: 41.7 });
  });
});

describe("QuotaWorker events", () => {
  it("folds a burst of usage events into one pass and ignores other events", async () => {
    const { engine, emit, dispatched, model } = setup({ usdPerWeek: 100, onExceed: "hold" });
    const counting = new QuotaWorker({ engine, now: () => NOW, schedule: () => () => undefined });
    let ticks = 0;
    const original = counting.tick.bind(counting);
    counting.tick = async () => {
      ticks++;
      return original();
    };
    counting.start();
    await counting.drain();
    expect(ticks).toBe(1); // the pass at start
    addCost(model, "2", 50);
    emit({ type: "usage.reported", turnId: "2", threadId: "a", usage: usd(50), at: NOW });
    emit({ type: "turn.settled", turnId: "2", threadId: "a", status: "completed", settledAt: NOW });
    emit({ type: "usage.corrected", turnId: "2", threadId: "a", usage: usd(0), reason: "x", at: NOW });
    await counting.drain();
    expect(ticks).toBe(2);
    emit({ type: "turn.dequeued", turnId: "2", threadId: "a", at: NOW });
    await counting.drain();
    expect(ticks).toBe(2);
    expect(dispatched.filter((c) => c.type === "quota.meter")).toHaveLength(2);
    counting.stop();
    emit({ type: "usage.reported", turnId: "2", threadId: "a", at: NOW });
    await counting.drain();
    expect(ticks).toBe(2);
  });

  it("re-arms its timer after every timed pass and stops cleanly", async () => {
    const { engine } = setup({ usdPerWeek: 100, onExceed: "hold" });
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const worker = new QuotaWorker({
      engine,
      now: () => NOW,
      schedule: (fn, ms): CancelTimer => {
        const t = { fn, ms, cancelled: false };
        timers.push(t);
        return () => {
          t.cancelled = true;
        };
      },
    });
    worker.start();
    await worker.drain();
    expect(timers.map((t) => t.ms)).toEqual([60_000]);
    timers[0]?.fn();
    await worker.drain();
    await Promise.resolve();
    expect(timers).toHaveLength(2);
    worker.stop();
    expect(timers[1]?.cancelled).toBe(true);
  });
});

describe("meterChanged", () => {
  const base = { status: "ok" as const, usedPct: 41, basis: "usd" as const, over: [], at: 1 };
  it("ignores time and a lift, not a step or the over set", () => {
    expect(meterChanged(base, { ...base, usedPct: 44.9, at: 2 }, NOW)).toBe(false);
    expect(meterChanged({ ...base, liftedUntil: NOW + 1 }, base, NOW)).toBe(false);
    expect(meterChanged(base, { ...base, usedPct: 45 }, NOW)).toBe(true);
    expect(meterChanged(base, { ...base, over: ["claude"] }, NOW)).toBe(true);
    expect(meterChanged(undefined, base, NOW)).toBe(true);
  });
});

describe("harnessLogSpend", () => {
  it("prices the kind's buckets: reported cost when every call had one, else the estimate", async () => {
    const model = modelWith([], []);
    const engine = fakeEngine(model).engine;
    let scans = 0;
    const spend = harnessLogSpend({
      engine,
      home: "/nowhere",
      scan: async () => {
        scans++;
        return {
          notes: [],
          buckets: [
            { day: "d", provider: "claude", model: "claude-sonnet-5-5", source: "external", tokens: { in: 1_000_000, out: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, reported: 0, count: 3 },
            { day: "d", provider: "codex", source: "external", tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, cost: 7, reported: 1, count: 1 },
          ],
        };
      },
    });
    expect(await spend("claude", 0, NOW)).toEqual({ usd: 2, approx: true });
    expect(await spend("codex", 0, NOW)).toEqual({ usd: 7, approx: false });
    expect(scans).toBe(1);
  });
});
