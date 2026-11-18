import { describe, expect, it } from "vitest";
import type { QuotaState, ReadModel, Team } from "@tide/contracts";
import { ctx, eventOf, run, startTurn, tryRun, withThread } from "./r4.fixtures.ts";

const FAR = 9_000_000_000; // past any fixture clock (it moves with every command)
const exceeded = (extra: Partial<QuotaState> = {}): QuotaState => ({ status: "exceeded", usedPct: 110, basis: "share", over: ["claude"], at: ctx.now, ...extra });

/** A claude thread whose project holds at its quota. */
function blocked(state: Partial<QuotaState> = {}, provider: "claude" | "codex" = "claude") {
  const f = withThread(provider);
  const projectId = f.model.threads[f.threadId]?.projectId ?? "";
  let model = run(f.model, { type: "quota.set", scope: "project", id: projectId, quota: { sharePct: 30, onExceed: "hold" } }).model;
  model = run(model, { type: "quota.meter", scope: "project", id: projectId, state: exceeded(state) }).model;
  return { model, threadId: f.threadId, projectId };
}

/** An idle thread whose queue a quota held: a turn ran, a follow-up queued, the quota hit, the turn settled. */
function heldQueue(followUps = 1) {
  const f = withThread();
  const projectId = f.model.threads[f.threadId]?.projectId ?? "";
  const live = startTurn(f.model, f.threadId, "go");
  let model = live.model;
  const queuedIds: string[] = [];
  for (let i = 0; i < followUps; i++) {
    const q = run(model, { type: "turn.request", threadId: f.threadId, text: `then ${i}` });
    queuedIds.push(eventOf(q.events, "turn.requested").turn.id);
    model = q.model;
  }
  model = run(model, { type: "quota.set", scope: "project", id: projectId, quota: { sharePct: 30, onExceed: "hold" } }).model;
  model = run(model, { type: "quota.meter", scope: "project", id: projectId, state: exceeded() }).model;
  const settled = run(model, { type: "turn.settle", turnId: live.turnId, status: "completed" });
  expect(eventOf(settled.events, "turn.settled").holdQueue).toBe(true);
  return { model: settled.model, threadId: f.threadId, projectId, queuedIds, liveId: live.turnId };
}

const team: Team = { id: "t1", name: "Solo", stages: [{ key: "lead", role: "planner", provider: "claude", worktree: "own" }] };

describe("quota gate: who may start a turn on a blocked thread", () => {
  it("refuses a user send with quota-exceeded, naming the scope and the reset", () => {
    const b = blocked({ windowEndsAt: Date.UTC(2026, 10, 19, 14, 0) });
    const refused = tryRun(b.model, { type: "turn.request", threadId: b.threadId, text: "go" });
    expect(refused).toMatchObject({ ok: false, error: { code: "quota-exceeded" } });
    if (refused.ok) return;
    expect(refused.error.message).toContain('project "T"');
    expect(refused.error.message).toContain("2026-11-19 14:00 UTC");
  });

  it("lets a harness-initiated turn through", () => {
    const b = blocked();
    const out = run(b.model, { type: "turn.request", threadId: b.threadId, text: "sub-agent report", notification: { source: "harness", summary: "report" } });
    expect(eventOf(out.events, "turn.requested").turn.status).toBe("requested");
  });

  it("queues a server wake-up on an idle thread; the thread stays idle with its queue until the lift", () => {
    const b = blocked();
    const out = run(b.model, { type: "turn.request", threadId: b.threadId, text: "delegate done", notification: { source: "delegate", summary: "done" } });
    const turn = eventOf(out.events, "turn.requested").turn;
    expect(turn.status).toBe("queued");
    expect(out.model.threads[b.threadId]?.status).toBe("idle");
    const lifted = run(out.model, { type: "quota.lift", scope: "project", id: b.projectId });
    expect(eventOf(lifted.events, "turn.released")).toMatchObject({ threadId: b.threadId, turnId: turn.id });
    expect(lifted.model.threads[b.threadId]).toMatchObject({ status: "running", latestTurnId: turn.id });
  });

  it("refuses delegate, team, task and resume-continue", () => {
    const b = blocked();
    const code = { ok: false, error: { code: "quota-exceeded" } };
    expect(tryRun(b.model, { type: "thread.delegate", fromThreadId: b.threadId, provider: "claude", prompt: "do it" })).toMatchObject(code);
    // the lead thread is created in the same batch, under the blocked project
    expect(tryRun(b.model, { type: "team.run", projectId: b.projectId, team, task: "x" })).toMatchObject(code);
    const task = run(b.model, { type: "task.create", projectId: b.projectId, title: "Nightly", prompt: "check", schedule: { kind: "interval", everyMs: 60_000 }, provider: "claude" } as never);
    const taskId = eventOf(task.events, "task.created").task.id;
    expect(tryRun(task.model, { type: "task.run-now", taskId })).toMatchObject(code);
    expect(tryRun(task.model, { type: "task.fire", taskId })).toMatchObject(code);
    const limited = run(b.model, { type: "thread.limited", threadId: b.threadId }).model;
    expect(tryRun(limited, { type: "thread.resume", threadId: b.threadId, continue: true })).toMatchObject(code);
  });

  it("counts a delegate living in another project against its root's project", () => {
    const b = blocked();
    const other = run(b.model, { type: "project.create", title: "Other", rootPath: `/other-${ctx.now}` });
    const otherId = eventOf(other.events, "project.created").project.id;
    const root = other.model.threads[b.threadId]!;
    const delegate = { ...root, id: "d1", projectId: otherId, delegatedBy: root.id, parentThreadId: root.id, title: "Delegate" };
    const model: ReadModel = { ...other.model, threads: { ...other.model.threads, d1: delegate } };
    expect(tryRun(model, { type: "turn.request", threadId: "d1", text: "go" })).toMatchObject({ ok: false, error: { code: "quota-exceeded" } });
  });

  it("passes an instance the state does not name, a lifted state and an ended window", () => {
    const codex = blocked({}, "codex");
    expect(run(codex.model, { type: "turn.request", threadId: codex.threadId, text: "go" }).events.length).toBeGreaterThan(0);
    const lifted = blocked({ liftedUntil: FAR });
    expect(eventOf(run(lifted.model, { type: "turn.request", threadId: lifted.threadId, text: "go" }).events, "turn.requested").turn.status).toBe("requested");
    const ended = blocked({ windowEndsAt: 1 });
    expect(eventOf(run(ended.model, { type: "turn.request", threadId: ended.threadId, text: "go" }).events, "turn.requested").turn.status).toBe("requested");
    const warn = withThread();
    const projectId = warn.model.threads[warn.threadId]?.projectId ?? "";
    let model = run(warn.model, { type: "quota.set", scope: "project", id: projectId, quota: { sharePct: 30, onExceed: "warn" } }).model;
    model = run(model, { type: "quota.meter", scope: "project", id: projectId, state: exceeded() }).model;
    expect(run(model, { type: "turn.request", threadId: warn.threadId, text: "go" }).events.length).toBeGreaterThan(0);
  });
});

describe("turn.settle: holdQueue", () => {
  it("holds the queue when a quota holds the thread", () => {
    const h = heldQueue();
    expect(h.model.threads[h.threadId]?.status).toBe("idle");
    expect(h.model.turns[h.queuedIds[0]!]?.status).toBe("queued");
  });

  it("holds on the harness's limit; never without a queue; not when nothing holds", () => {
    const f = withThread();
    const a = startTurn(f.model, f.threadId, "go");
    const q = run(a.model, { type: "turn.request", threadId: f.threadId, text: "next" }).model;
    expect(eventOf(run(q, { type: "turn.settle", turnId: a.turnId, status: "error", holdQueue: true }).events, "turn.settled").holdQueue).toBe(true);
    expect(eventOf(run(q, { type: "turn.settle", turnId: a.turnId, status: "completed" }).events, "turn.settled").holdQueue).toBeUndefined();
    expect(eventOf(run(a.model, { type: "turn.settle", turnId: a.turnId, status: "error", holdQueue: true }).events, "turn.settled").holdQueue).toBeUndefined();
  });
});

describe("releases", () => {
  it("lift, set, remove and a meter leaving exceeded each release the oldest queued turn, once", () => {
    const h = heldQueue(2);
    const oldest = h.queuedIds[0];
    const releasedBy = (command: Parameters<typeof run>[1]) => run(h.model, command).events.filter((e) => e.type === "turn.released");
    for (const command of [
      { type: "quota.lift" as const, scope: "project" as const, id: h.projectId },
      { type: "quota.set" as const, scope: "project" as const, id: h.projectId, quota: { sharePct: 50, onExceed: "hold" as const } },
      { type: "quota.set" as const, scope: "project" as const, id: h.projectId },
      { type: "quota.meter" as const, scope: "project" as const, id: h.projectId, state: { status: "ok" as const, usedPct: 20, basis: "share" as const, over: [], at: ctx.now } },
    ]) {
      const released = releasedBy(command);
      expect(released).toHaveLength(1);
      expect(released[0]).toMatchObject({ threadId: h.threadId, turnId: oldest });
    }
  });

  it("a meter still exceeded releases nothing; a thread quota lift does not free a thread the project holds", () => {
    const h = heldQueue();
    expect(run(h.model, { type: "quota.meter", scope: "project", id: h.projectId, state: exceeded({ usedPct: 130 }) }).events.some((e) => e.type === "turn.released")).toBe(false);
    let model = run(h.model, { type: "quota.set", scope: "thread", id: h.threadId, quota: { usdPerWeek: 1, onExceed: "hold" } }).model;
    model = run(model, { type: "quota.meter", scope: "thread", id: h.threadId, state: exceeded() }).model;
    expect(run(model, { type: "quota.lift", scope: "thread", id: h.threadId }).events.some((e) => e.type === "turn.released")).toBe(false);
  });

  it("never releases a running or a limited thread", () => {
    const h = heldQueue();
    const limited = run(h.model, { type: "thread.limited", threadId: h.threadId }).model;
    expect(run(limited, { type: "quota.lift", scope: "project", id: h.projectId }).events.some((e) => e.type === "turn.released")).toBe(false);
    // a running thread: its queue follows the normal promotion
    const f = withThread();
    const projectId = f.model.threads[f.threadId]?.projectId ?? "";
    const a = startTurn(f.model, f.threadId, "go");
    let model = run(a.model, { type: "turn.request", threadId: f.threadId, text: "next" }).model;
    model = run(model, { type: "quota.set", scope: "project", id: projectId, quota: { sharePct: 30, onExceed: "hold" } }).model;
    model = run(model, { type: "quota.meter", scope: "project", id: projectId, state: exceeded() }).model;
    expect(run(model, { type: "quota.lift", scope: "project", id: projectId }).events.some((e) => e.type === "turn.released")).toBe(false);
  });

  it("releases a delegate's queue when its root's project quota is lifted", () => {
    const h = heldQueue();
    const other = run(h.model, { type: "project.create", title: "Other", rootPath: `/other-${ctx.now}` });
    const otherId = eventOf(other.events, "project.created").project.id;
    const root = other.model.threads[h.threadId]!;
    // move the held queue onto a delegate in the other project
    const model: ReadModel = { ...other.model, threads: { ...other.model.threads, [root.id]: { ...root, projectId: otherId, delegatedBy: "lead" }, lead: { ...root, id: "lead", status: "idle" } } };
    const released = run(model, { type: "quota.lift", scope: "project", id: h.projectId }).events.filter((e) => e.type === "turn.released");
    expect(released).toEqual([expect.objectContaining({ threadId: h.threadId })]);
  });

  it("a plain resume of a limited thread releases its held queue; with continue the continuation runs first", () => {
    const f = withThread();
    const a = startTurn(f.model, f.threadId, "go");
    const q = run(a.model, { type: "turn.request", threadId: f.threadId, text: "next" });
    const queuedId = eventOf(q.events, "turn.requested").turn.id;
    let model = run(q.model, { type: "thread.limited", threadId: f.threadId }).model;
    model = run(model, { type: "turn.settle", turnId: a.turnId, status: "error", holdQueue: true }).model;
    const plain = run(model, { type: "thread.resume", threadId: f.threadId });
    expect(plain.events.map((e) => e.type)).toEqual(["thread.resumed", "turn.released"]);
    expect(plain.model.threads[f.threadId]).toMatchObject({ status: "running", latestTurnId: queuedId });
    const cont = run(model, { type: "thread.resume", threadId: f.threadId, continue: true });
    expect(cont.events.map((e) => e.type)).toEqual(["thread.resumed", "turn.requested"]);
    expect(cont.model.turns[queuedId]?.status).toBe("queued");
  });

  it("a plain resume does not release a queue a quota still holds", () => {
    const h = heldQueue();
    const limited = run(h.model, { type: "thread.limited", threadId: h.threadId }).model;
    expect(run(limited, { type: "thread.resume", threadId: h.threadId }).events.map((e) => e.type)).toEqual(["thread.resumed"]);
  });

  it("promoting a held turn on a blocked thread is refused", () => {
    const h = heldQueue();
    expect(tryRun(h.model, { type: "turn.promote", turnId: h.queuedIds[0]! })).toMatchObject({ ok: false, error: { code: "quota-exceeded" } });
  });
});

describe("settle and archive disarm a limit", () => {
  it("emits thread.resumed with the settle or the archive of a limited thread", () => {
    const f = withThread();
    const limited = run(f.model, { type: "thread.limited", threadId: f.threadId, resetsAt: FAR }).model;
    const settled = run(limited, { type: "thread.settle", threadId: f.threadId });
    expect(settled.events.map((e) => e.type)).toEqual(["thread.settled", "thread.resumed"]);
    expect(settled.model.threads[f.threadId]?.limited).toBeUndefined();
    const archived = run(limited, { type: "thread.archive", threadId: f.threadId });
    expect(archived.events.map((e) => e.type)).toEqual(["thread.archived", "thread.resumed"]);
    expect(archived.model.threads[f.threadId]?.limited).toBeUndefined();
    expect(run(f.model, { type: "thread.settle", threadId: f.threadId }).events.map((e) => e.type)).toEqual(["thread.settled"]);
  });
});
