import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/sqlite.ts";
import { SettingsStore } from "../settings.ts";
import { Engine } from "./engine.ts";
import type { CancelTimer } from "./limits.ts";
import { SettlementReactor } from "./settlement.ts";
import { EventStore } from "./store.ts";

const DAY = 86_400_000;

async function setup(inbox: { autoSettleAfterDays?: number; autoSettleOnMerge?: boolean } = {}) {
  const clock = { now: 1_000 };
  const engine = new Engine({ store: new EventStore(await openDatabase(":memory:")), now: () => clock.now });
  const settings = new SettingsStore();
  settings.set({ inbox });
  const created = (await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
  if (created?.type !== "project.created") throw new Error("expected project");
  const projectId = created.project.id;
  const mk = async (extra: { title?: string; parentThreadId?: string } = {}): Promise<string> => {
    const e = (await engine.dispatch({ type: "thread.create", projectId, provider: "claude", ...extra })).events[0]?.event;
    if (e?.type !== "thread.created") throw new Error("expected thread");
    return e.thread.id;
  };
  const reactor = new SettlementReactor({ engine, settings, now: () => clock.now });
  return { engine, clock, mk, reactor, settings };
}

describe("SettlementReactor inactivity", () => {
  it("settles an idle thread past the threshold, once, and leaves fresh ones alone", async () => {
    const { engine, clock, mk, reactor } = await setup({ autoSettleAfterDays: 3 });
    const old = await mk();
    clock.now = 1_000 + 2 * DAY;
    expect(await reactor.tick()).toEqual([]);
    const fresh = await mk();
    clock.now = 1_000 + 3 * DAY;
    expect(await reactor.tick()).toEqual([old]);
    const m = engine.getModel();
    expect(m.threads[old]?.settleReason).toBe("inactive");
    expect(m.threads[fresh]?.settledAt).toBeUndefined();
    expect(await reactor.tick()).toEqual([]);
  });

  it("skips pinned, opted-out, attention, running and archived threads", async () => {
    const { engine, clock, mk, reactor } = await setup({ autoSettleAfterDays: 1 });
    const pinned = await mk();
    await engine.dispatch({ type: "thread.update", threadId: pinned, pinned: true });
    const optedOut = await mk();
    await engine.dispatch({ type: "thread.update", threadId: optedOut, autoSettle: false });
    const archived = await mk();
    await engine.dispatch({ type: "thread.archive", threadId: archived });
    const running = await mk();
    await engine.dispatch({ type: "turn.request", threadId: running, text: "go" });
    const turnId = Object.values(engine.getModel().turns).find((t) => t.threadId === running)!.id;
    await engine.dispatch({ type: "turn.start", turnId, provider: "claude" });
    const idle = await mk();
    clock.now = 1_000 + 5 * DAY;
    expect(await reactor.tick()).toEqual([idle]);
    expect(engine.getModel().threads[running]?.settledAt).toBeUndefined();
  });

  it("does not settle a parent with a running child", async () => {
    const { engine, clock, mk, reactor } = await setup({ autoSettleAfterDays: 1 });
    const parent = await mk();
    const child = await mk({ parentThreadId: parent });
    await engine.dispatch({ type: "turn.request", threadId: child, text: "go" });
    const turnId = Object.values(engine.getModel().turns).find((t) => t.threadId === child)!.id;
    await engine.dispatch({ type: "turn.start", turnId, provider: "claude" });
    clock.now = 1_000 + 5 * DAY;
    expect(await reactor.tick()).toEqual([]);
  });

  it("does nothing when autoSettleAfterDays is 0", async () => {
    const { clock, mk, reactor } = await setup({ autoSettleAfterDays: 0 });
    await mk();
    clock.now = 1_000 + 100 * DAY;
    expect(await reactor.tick()).toEqual([]);
  });

  it("ticks on its own schedule and stops cleanly", async () => {
    const { engine, settings } = await setup();
    const timers: { fn: () => void; cancelled: boolean }[] = [];
    const schedule = (fn: () => void): CancelTimer => {
      const t = { fn, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    };
    const reactor = new SettlementReactor({ engine, settings, schedule });
    reactor.start();
    expect(timers).toHaveLength(1);
    timers[0]!.fn();
    await engine.drain();
    await Promise.resolve();
    await Promise.resolve();
    reactor.stop();
    expect(timers.at(-1)!.cancelled).toBe(true);
  });
});

describe("SettlementReactor merge", () => {
  const mergeBack = async (engine: Engine, threadId: string): Promise<void> => {
    await engine.dispatch({ type: "worktree.attach", threadId, worktreePath: `/wt/${threadId}`, branch: `tide/${threadId}`, baseBranch: "main" });
    await engine.dispatch({ type: "thread.merge", threadId });
    await engine.dispatch({ type: "merge.report", threadId, outcome: "merged" });
  };
  const pr = (state: "open" | "merged", updatedAt: number) => ({ url: "u", number: 1, state, updatedAt });

  it("settles on the PR merge, and a later sync does not undo a manual unsettle", async () => {
    const { engine, clock, mk, reactor } = await setup();
    const id = await mk();
    reactor.start();
    await engine.dispatch({ type: "pr.update", threadId: id, pr: pr("open", 1_100) });
    await engine.drain();
    expect(engine.getModel().threads[id]?.settledAt).toBeUndefined();
    clock.now = 2_000;
    await engine.dispatch({ type: "pr.update", threadId: id, pr: pr("merged", 2_000) });
    await engine.drain();
    await engine.drain();
    expect(engine.getModel().threads[id]?.settleReason).toBe("pr-merged");
    await engine.dispatch({ type: "thread.unsettle", threadId: id });
    await engine.dispatch({ type: "pr.update", threadId: id, pr: pr("merged", 2_500) });
    await engine.drain();
    await engine.drain();
    expect(engine.getModel().threads[id]?.settledAt).toBeUndefined();
    reactor.stop();
  });

  it("settles on a PR carrying the forge's mergedAt, once, even when later syncs repeat it", async () => {
    const { engine, clock, mk, reactor } = await setup();
    const id = await mk();
    reactor.start();
    clock.now = 3_000;
    await engine.dispatch({ type: "pr.update", threadId: id, pr: { ...pr("merged", 3_000), mergedAt: 2_400 } });
    await engine.drain();
    await engine.drain();
    expect(engine.getModel().threads[id]).toMatchObject({ settleReason: "pr-merged", mergedAt: 2_400 });
    await engine.dispatch({ type: "thread.unsettle", threadId: id });
    await engine.dispatch({ type: "pr.update", threadId: id, pr: { ...pr("merged", 3_500), mergedAt: 2_400 } });
    await engine.drain();
    await engine.drain();
    expect(engine.getModel().threads[id]?.settledAt).toBeUndefined();
    reactor.stop();
  });

  it("settles on merge-back, and respects autoSettleOnMerge=false and pinned", async () => {
    const { engine, mk, reactor, settings } = await setup();
    const a = await mk();
    const pinned = await mk();
    await engine.dispatch({ type: "thread.update", threadId: pinned, pinned: true });
    reactor.start();
    await mergeBack(engine, a);
    await mergeBack(engine, pinned);
    await engine.drain();
    await engine.drain();
    expect(engine.getModel().threads[a]?.settleReason).toBe("merged-back");
    expect(engine.getModel().threads[pinned]?.settledAt).toBeUndefined();

    settings.set({ inbox: { autoSettleOnMerge: false } });
    const b = await mk();
    await mergeBack(engine, b);
    await engine.drain();
    await engine.drain();
    expect(engine.getModel().threads[b]?.settledAt).toBeUndefined();
    reactor.stop();
  });
});
