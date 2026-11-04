import { describe, expect, it } from "vitest";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore } from "../orchestration/store.ts";
import { Scheduler } from "./scheduler.ts";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

async function setup(start: number) {
  let clock = start;
  const store = await openEventStore(":memory:");
  const engine = new Engine({ store, now: () => clock });
  const project = (await engine.dispatch({ type: "project.create", title: "P", rootPath: "/p" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("project");
  const projectId = project.project.id;
  const settings = { get: () => ({ worktreeByDefault: false }) as never };
  const logs: string[] = [];
  const scheduler = new Scheduler({ engine, settings, now: () => clock, log: (m) => logs.push(m) });
  return { engine, projectId, scheduler, logs, advance: (ms: number) => (clock += ms), set: (t: number) => (clock = t) };
}

describe("Scheduler", () => {
  it("fires once per slot and is idempotent across ticks", async () => {
    const s = await setup(1_000_000);
    const created = await s.engine.dispatch({ type: "task.create", projectId: s.projectId, title: "T", prompt: "go", schedule: { kind: "interval", everyMs: 60_000 } });
    const taskId = Object.keys(s.engine.getModel().scheduledTasks)[0] as string;
    expect(created.events).toHaveLength(1);
    expect(await s.scheduler.tick()).toEqual([]);
    s.advance(60_000);
    expect(await s.scheduler.tick()).toEqual([taskId]);
    expect(await s.scheduler.tick()).toEqual([]);
    const task = s.engine.getModel().scheduledTasks[taskId];
    expect(task).toMatchObject({ runs: 1, nextRunAt: 1_000_000 + 120_000 });
    expect(Object.keys(s.engine.getModel().threads)).toHaveLength(1);
    s.advance(60_000);
    expect(await s.scheduler.tick()).toEqual([taskId]);
    expect(s.engine.getModel().scheduledTasks[taskId]?.runs).toBe(2);
  });

  it("ignores disabled tasks; an overdue interval catches up once", async () => {
    const s = await setup(1_000_000);
    await s.engine.dispatch({ type: "task.create", projectId: s.projectId, title: "Off", prompt: "x", enabled: false, schedule: { kind: "interval", everyMs: 60_000 } });
    await s.engine.dispatch({ type: "task.create", projectId: s.projectId, title: "On", prompt: "x", schedule: { kind: "interval", everyMs: 60_000 } });
    s.advance(10 * 60_000);
    const fired = await s.scheduler.tick();
    expect(fired).toHaveLength(1);
    const tasks = Object.values(s.engine.getModel().scheduledTasks);
    expect(tasks.find((t) => t.title === "On")).toMatchObject({ runs: 1, nextRunAt: 1_000_000 + 11 * 60_000 });
    expect(tasks.find((t) => t.title === "Off")?.runs).toBe(0);
    expect(await s.scheduler.tick()).toEqual([]);
  });

  it("fixed times: a missed slot is skipped and the next one computed across a weekend", async () => {
    const friday = at(2026, 10, 16, 8, 0);
    const s = await setup(friday);
    await s.engine.dispatch({ type: "task.create", projectId: s.projectId, title: "Daily", prompt: "x", schedule: { kind: "fixed", times: ["09:00"], weekdays: [1, 2, 3, 4, 5] } });
    const taskId = Object.keys(s.engine.getModel().scheduledTasks)[0] as string;
    expect(s.engine.getModel().scheduledTasks[taskId]?.nextRunAt).toBe(at(2026, 10, 16, 9, 0));
    // server was asleep through Friday's slot: it fires once, then jumps to Monday
    s.set(at(2026, 10, 16, 9, 0) + 1000);
    expect(await s.scheduler.tick()).toEqual([taskId]);
    expect(s.engine.getModel().scheduledTasks[taskId]?.nextRunAt).toBe(at(2026, 10, 19, 9, 0));
    s.set(at(2026, 10, 17, 12, 0));
    expect(await s.scheduler.tick()).toEqual([]);
  });

  it("a rejected fire is logged once and not retried until nextRunAt changes", async () => {
    const s = await setup(1_000_000);
    const th = (await s.engine.dispatch({ type: "thread.create", projectId: s.projectId, provider: "claude" })).events[0]?.event;
    if (th?.type !== "thread.created") throw new Error("thread");
    await s.engine.dispatch({ type: "task.create", projectId: s.projectId, threadId: th.thread.id, title: "T", prompt: "x", schedule: { kind: "interval", everyMs: 60_000 } });
    await s.engine.dispatch({ type: "thread.archive", threadId: th.thread.id });
    s.advance(60_000);
    expect(await s.scheduler.tick()).toEqual([]);
    expect(await s.scheduler.tick()).toEqual([]);
    expect(s.logs).toHaveLength(1);
  });

  it("start schedules one repeating timer, stop cancels it", async () => {
    const s = await setup(1);
    const timers: { ms: number; cancelled: boolean }[] = [];
    const sched = new Scheduler({ engine: s.engine, schedule: (_fn, ms) => { const t = { ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; } });
    sched.start();
    sched.start();
    expect(timers).toEqual([{ ms: 5000, cancelled: false }]);
    sched.stop();
    expect(timers[0]?.cancelled).toBe(true);
  });

  it("once: fires at its time, runs a single turn, then disables itself", async () => {
    const s = await setup(1_000_000);
    await s.engine.dispatch({ type: "task.create", projectId: s.projectId, title: "Once", prompt: "go", schedule: { kind: "once", at: 1_060_000 } });
    const taskId = Object.keys(s.engine.getModel().scheduledTasks)[0] as string;
    expect(await s.scheduler.tick()).toEqual([]);
    s.set(1_060_000);
    expect(await s.scheduler.tick()).toEqual([taskId]);
    expect(s.engine.getModel().scheduledTasks[taskId]).toMatchObject({ runs: 1, enabled: false, completedAt: 1_060_000 });
    s.advance(3_600_000);
    expect(await s.scheduler.tick()).toEqual([]);
    expect(s.engine.getModel().scheduledTasks[taskId]?.runs).toBe(1);
    expect(Object.keys(s.engine.getModel().threads)).toHaveLength(1);
  });

  it("once: a time missed while the server was down fires on the first tick; a replayed commandId does not double-fire", async () => {
    const s = await setup(1_000_000);
    await s.engine.dispatch({ type: "task.create", projectId: s.projectId, title: "Once", prompt: "go", schedule: { kind: "once", at: 1_060_000 } });
    const taskId = Object.keys(s.engine.getModel().scheduledTasks)[0] as string;
    s.set(9_000_000);
    expect(await s.scheduler.tick()).toEqual([taskId]);
    // the same fire arriving again (a restart re-dispatching the slot) is a receipt replay
    const seq = s.engine.getModel().seq;
    await s.engine.dispatch({ type: "task.fire", commandId: `scheduled:${taskId}:1060000`, taskId, nextRunAt: 1_060_000, useWorktreeDefault: false });
    expect(s.engine.getModel().seq).toBe(seq);
    expect(s.engine.getModel().scheduledTasks[taskId]?.runs).toBe(1);
    expect(Object.keys(s.engine.getModel().threads)).toHaveLength(1);
  });
});
