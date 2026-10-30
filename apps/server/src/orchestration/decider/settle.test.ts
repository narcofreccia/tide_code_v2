import { describe, expect, it } from "vitest";
import { ctx, completeTurn, eventOf, run, startTurn, tryRun, withThread } from "./r4.fixtures.ts";

describe("decide: thread.settle / unsettle", () => {
  it("settles as the user by default and is idempotent", () => {
    const f = withThread();
    const s = run(f.model, { type: "thread.settle", threadId: f.threadId });
    expect(eventOf(s.events, "thread.settled")).toMatchObject({ reason: "user", at: ctx.now });
    expect(s.model.threads[f.threadId]?.settledAt).toBe(ctx.now);
    expect(run(s.model, { type: "thread.settle", threadId: f.threadId }).events).toEqual([]);
  });

  it("refuses unknown and archived threads", () => {
    const f = withThread();
    expect(tryRun(f.model, { type: "thread.settle", threadId: "nope" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    const archived = run(f.model, { type: "thread.archive", threadId: f.threadId }).model;
    expect(tryRun(archived, { type: "thread.settle", threadId: f.threadId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("refuses automatic reasons for running, pinned and opted-out threads, allows the user", () => {
    const f = withThread();
    const pinned = run(f.model, { type: "thread.update", threadId: f.threadId, pinned: true }).model;
    expect(tryRun(pinned, { type: "thread.settle", threadId: f.threadId, reason: "inactive" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(tryRun(pinned, { type: "thread.settle", threadId: f.threadId }).ok).toBe(true);
    const out = run(f.model, { type: "thread.update", threadId: f.threadId, autoSettle: false });
    expect(out.model.threads[f.threadId]?.autoSettle).toBe(false);
    expect(tryRun(out.model, { type: "thread.settle", threadId: f.threadId, reason: "pr-merged" })).toMatchObject({ ok: false });
    const running = startTurn(f.model, f.threadId, "go").model;
    expect(tryRun(running, { type: "thread.settle", threadId: f.threadId, reason: "merged-back" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("allows an automatic reason on an idle, unpinned thread", () => {
    const f = withThread();
    const s = run(f.model, { type: "thread.settle", threadId: f.threadId, reason: "inactive" });
    expect(s.model.threads[f.threadId]?.settleReason).toBe("inactive");
  });

  it("unsettle clears the state, idempotently", () => {
    const f = withThread();
    const s = run(f.model, { type: "thread.settle", threadId: f.threadId }).model;
    const u = run(s, { type: "thread.unsettle", threadId: f.threadId });
    expect(eventOf(u.events, "thread.unsettled")).toBeDefined();
    expect(u.model.threads[f.threadId]?.settledAt).toBeUndefined();
    expect(u.model.threads[f.threadId]?.settleReason).toBeUndefined();
    expect(run(u.model, { type: "thread.unsettle", threadId: f.threadId }).events).toEqual([]);
  });

  it("a new turn brings a settled thread back", () => {
    const f = withThread();
    const s = run(f.model, { type: "thread.settle", threadId: f.threadId }).model;
    const next = completeTurn(s, f.threadId, "again", "ok").model;
    expect(next.threads[f.threadId]?.settledAt).toBeUndefined();
    expect(next.threads[f.threadId]?.settleReason).toBeUndefined();
  });
});
