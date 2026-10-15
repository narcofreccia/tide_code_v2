import { describe, expect, it } from "vitest";
import { ctx, eventOf, run, startTurn, tryRun, withThread } from "./r4.fixtures.ts";

const interval = { kind: "interval" as const, everyMs: 60_000 };

function base() {
  const f = withThread("codex");
  const projectId = f.model.threads[f.threadId]?.projectId as string;
  return { ...f, projectId };
}

function created(f: ReturnType<typeof base>, extra: Record<string, unknown> = {}) {
  const r = run(f.model, { type: "task.create", projectId: f.projectId, title: "Nightly", prompt: "check CI", schedule: interval, ...extra } as never);
  return { model: r.model, taskId: eventOf(r.events, "task.created").task.id, events: r.events };
}

describe("decide: task.create / update / delete", () => {
  it("creates an enabled task with a computed nextRunAt", () => {
    const f = base();
    const { model, taskId } = created(f);
    const task = model.scheduledTasks[taskId];
    expect(task).toMatchObject({ enabled: true, runs: 0, nextRunAt: ctx.now + 60_000, projectId: f.projectId });
  });

  it("rejects unknown/archived projects, foreign threads and duplicate times", () => {
    const f = base();
    const other = withThread();
    const otherThread = other.threadId;
    expect(tryRun(f.model, { type: "task.create", projectId: "nope", title: "x", prompt: "p", schedule: interval })).toMatchObject({ ok: false, error: { code: "not-found" } });
    const merged = { ...f.model, threads: { ...f.model.threads, ...other.model.threads }, projects: { ...f.model.projects, ...other.model.projects } };
    expect(tryRun(merged, { type: "task.create", projectId: f.projectId, threadId: otherThread, title: "x", prompt: "p", schedule: interval })).toMatchObject({ ok: false });
    expect(tryRun(f.model, { type: "task.create", projectId: f.projectId, title: "x", prompt: "p", schedule: { kind: "fixed", times: ["09:00", "09:00"], weekdays: [1] } })).toMatchObject({ ok: false, error: { code: "invalid-command" } });
    const archived = run(f.model, { type: "project.archive", projectId: f.projectId });
    expect(tryRun(archived.model, { type: "task.create", projectId: f.projectId, title: "x", prompt: "p", schedule: interval })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("update patches only given fields; a schedule change recomputes nextRunAt", () => {
    const f = base();
    const t = created(f);
    const renamed = run(t.model, { type: "task.update", taskId: t.taskId, title: "Renamed" });
    expect(eventOf(renamed.events, "task.updated").patch).toEqual({ title: "Renamed" });
    const resched = run(renamed.model, { type: "task.update", taskId: t.taskId, schedule: { kind: "interval", everyMs: 120_000 } });
    expect(eventOf(resched.events, "task.updated").patch.nextRunAt).toBe(ctx.now + 120_000);
    const off = run(resched.model, { type: "task.update", taskId: t.taskId, enabled: false });
    expect(eventOf(off.events, "task.updated").patch).toEqual({ enabled: false });
    const on = run(off.model, { type: "task.update", taskId: t.taskId, enabled: true });
    expect(eventOf(on.events, "task.updated").patch.nextRunAt).toBe(ctx.now + 120_000);
  });

  it("delete archives; a second delete is a no-op; update of a deleted task conflicts", () => {
    const f = base();
    const t = created(f);
    const del = run(t.model, { type: "task.delete", taskId: t.taskId });
    expect(del.model.scheduledTasks[t.taskId]?.archivedAt).toBeDefined();
    const again = tryRun(del.model, { type: "task.delete", taskId: t.taskId });
    expect(again).toEqual({ ok: true, events: [] });
    expect(tryRun(del.model, { type: "task.update", taskId: t.taskId, title: "x" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(tryRun(del.model, { type: "task.delete", taskId: "nope" })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});

describe("decide: task.fire / task.run-now", () => {
  it("new-thread task: creates a thread, requests the turn, records the fire", () => {
    const f = base();
    const t = created(f, { title: "Triage" });
    const fired = run(t.model, { type: "task.fire", commandId: "c1", taskId: t.taskId, nextRunAt: 9999, useWorktreeDefault: false });
    expect(fired.events.map((e) => e.type)).toEqual(["thread.created", "turn.requested", "task.fired"]);
    const thread = eventOf(fired.events, "thread.created");
    expect(thread.thread).toMatchObject({ title: "Triage", provider: "codex", projectId: f.projectId });
    expect(thread.useWorktree).toBe(false);
    const req = eventOf(fired.events, "turn.requested");
    expect(req.userMessage).toMatchObject({ text: "check CI", notification: { source: "schedule", summary: "scheduled: Triage" } });
    const task = fired.model.scheduledTasks[t.taskId];
    expect(task).toMatchObject({ runs: 1, nextRunAt: 9999, lastRunThreadId: thread.thread.id });
  });

  it("task.useWorktree beats the default; provider falls back to claude in an empty project", () => {
    const f = base();
    const t = created(f, { useWorktree: true, provider: "pi" });
    const fired = run(t.model, { type: "task.fire", commandId: "c", taskId: t.taskId, useWorktreeDefault: false });
    const thread = eventOf(fired.events, "thread.created");
    expect(thread.useWorktree).toBe(true);
    expect(thread.thread.provider).toBe("pi");
  });

  it("existing-thread task: requests a turn, queued when the thread is running", () => {
    const f = base();
    const t = created(f, { threadId: f.threadId });
    const idle = run(t.model, { type: "task.fire", commandId: "c", taskId: t.taskId });
    expect(idle.events.map((e) => e.type)).toEqual(["turn.requested", "task.fired"]);
    expect(eventOf(idle.events, "turn.requested").turn.status).toBe("requested");
    const live = startTurn(t.model, f.threadId, "work");
    const queued = run(live.model, { type: "task.fire", commandId: "c2", taskId: t.taskId });
    expect(eventOf(queued.events, "turn.requested").turn.status).toBe("queued");
  });

  it("fire on a disabled task is a no-op; run-now ignores enabled and leaves nextRunAt", () => {
    const f = base();
    const t = created(f, { enabled: false });
    expect(tryRun(t.model, { type: "task.fire", commandId: "c", taskId: t.taskId })).toEqual({ ok: true, events: [] });
    const now = run(t.model, { type: "task.run-now", taskId: t.taskId });
    expect(eventOf(now.events, "task.fired").nextRunAt).toBeUndefined();
    expect(now.model.scheduledTasks[t.taskId]?.nextRunAt).toBe(t.model.scheduledTasks[t.taskId]?.nextRunAt);
  });

  it("refuses a target thread that is archived or lost its worktree", () => {
    const f = base();
    const t = created(f, { threadId: f.threadId });
    const archived = run(t.model, { type: "thread.archive", threadId: f.threadId });
    expect(tryRun(archived.model, { type: "task.fire", commandId: "c", taskId: t.taskId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const wt = withThread("claude", true);
    const projectId = wt.model.threads[wt.threadId]?.projectId as string;
    const t2 = run(wt.model, { type: "task.create", projectId, threadId: wt.threadId, title: "x", prompt: "p", schedule: interval });
    const taskId = eventOf(t2.events, "task.created").task.id;
    const detached = run(t2.model, { type: "worktree.detached", threadId: wt.threadId } as never);
    expect(tryRun(detached.model, { type: "task.fire", commandId: "c", taskId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
