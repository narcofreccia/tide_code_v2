import { describe, expect, it } from "vitest";
import type { ReadModel, Thread } from "@tide/contracts";
import { completeTurn, eventOf, run, startTurn, tryRun, withThread } from "./r4.fixtures.ts";
import { sideTitle } from "./side.ts";
import { inheritedFrom } from "./vcs.ts";

function side(model: ReadModel, threadId: string, title?: string) {
  const { model: next, events } = run(model, { type: "thread.side", threadId, ...(title !== undefined ? { title } : {}) });
  const sideId = eventOf(events, "thread.created").thread.id;
  return { model: next, events, sideId };
}

function patchThread(model: ReadModel, id: string, patch: Partial<Thread>): ReadModel {
  const thread = model.threads[id] as Thread;
  return { ...model, threads: { ...model.threads, [id]: { ...thread, ...patch } } };
}

describe("decide: thread.side", () => {
  it("without history: a bare side thread, no handoff, no checkout work", () => {
    const base = withThread();
    const { model, events, sideId } = side(base.model, base.threadId);
    expect(events.map((e) => e.type)).toEqual(["thread.created"]);
    const created = eventOf(events, "thread.created");
    expect(created.thread).toMatchObject({ role: "side", parentThreadId: base.threadId, title: "Side: Login fix", provider: "claude", status: "idle" });
    expect(created.thread.forkedFrom).toBeUndefined();
    expect(created.useWorktree).toBeUndefined();
    expect(created.baseRef).toBeUndefined();
    expect(model.threads[sideId]?.worktreePath).toBeUndefined();
    expect(model.threads[sideId]?.pendingHandoffId).toBeUndefined();
  });

  it("with history: forks at the latest settled turn with a full, pending handoff", () => {
    const base = withThread();
    const t1 = completeTurn(base.model, base.threadId, "fix the login form", "patched");
    const t2 = completeTurn(t1.model, base.threadId, "add a test", "added");
    const live = startTurn(t2.model, base.threadId, "still running");
    const { model, events, sideId } = side(live.model, base.threadId);
    expect(events.map((e) => e.type)).toEqual(["thread.created", "handoff.recorded"]);
    expect(eventOf(events, "thread.created").thread.forkedFrom).toEqual({ threadId: base.threadId, turnId: t2.turnId });
    const { handoff } = eventOf(events, "handoff.recorded");
    expect(handoff).toMatchObject({ threadId: sideId, sourceThreadId: base.threadId, fromProvider: "claude", toProvider: "claude", strategy: "full" });
    expect(handoff.coveredTurnIds).toEqual([t1.turnId, t2.turnId]);
    expect(handoff.text).not.toContain("still running");
    expect(model.threads[sideId]?.pendingHandoffId).toBe(handoff.id);
  });

  it("copies the parent's harness settings and links, and takes an explicit title", () => {
    const base = withThread();
    const parent = patchThread(base.model, base.threadId, {
      providerId: "claude-work", model: "opus-9", effort: "high", mode: "auto", interaction: "plan",
      links: [{ linkId: "l1", access: "read" }],
    });
    const { events } = side(parent, base.threadId, "Quick question");
    expect(eventOf(events, "thread.created").thread).toMatchObject({
      title: "Quick question", providerId: "claude-work", model: "opus-9", effort: "high", mode: "auto", interaction: "plan",
      links: [{ linkId: "l1", access: "read" }],
    });
  });

  it("default title: first 40 chars of the parent's, else Side chat", () => {
    expect(sideTitle("x".repeat(60))).toBe(`Side: ${"x".repeat(40)}`);
    expect(sideTitle("   ")).toBe("Side chat");
  });

  it("shares the parent's worktree as a non-owner, exactly like an inheriting delegate", () => {
    const base = withThread("claude", true);
    const { model, events, sideId } = side(base.model, base.threadId);
    expect(eventOf(events, "thread.created").useWorktree).toBeUndefined();
    expect(eventOf(events, "worktree.attached")).toMatchObject({ threadId: sideId, worktreePath: "/wt/thread", branch: "tide/login", baseBranch: "main" });
    expect(model.threads[sideId]).toMatchObject({ worktreePath: "/wt/thread", branch: "tide/login", baseBranch: "main" });
    expect(inheritedFrom(model, model.threads[sideId] as Thread)?.id).toBe(base.threadId);
    expect(inheritedFrom(model, model.threads[base.threadId] as Thread)).toBeUndefined();
    expect(tryRun(model, { type: "thread.publish", threadId: sideId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(tryRun(model, { type: "thread.merge", threadId: sideId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("payload is self-contained: the projected thread is the event's thread plus the attach", () => {
    const base = withThread();
    const { model, events, sideId } = side(base.model, base.threadId);
    expect(model.threads[sideId]).toEqual(eventOf(events, "thread.created").thread);
  });

  it("refuses unknown, archived, side-of-side and rolling-back parents", () => {
    const base = withThread();
    expect(tryRun(base.model, { type: "thread.side", threadId: "nope" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    const archived = run(base.model, { type: "thread.archive", threadId: base.threadId }).model;
    expect(tryRun(archived, { type: "thread.side", threadId: base.threadId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const { model, sideId } = side(base.model, base.threadId);
    expect(tryRun(model, { type: "thread.side", threadId: sideId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const t1 = completeTurn(base.model, base.threadId, "go", "done");
    const rolling = run(t1.model, { type: "thread.rollback", threadId: base.threadId, turnId: t1.turnId, restoreFiles: false }).model;
    expect(tryRun(rolling, { type: "thread.side", threadId: base.threadId })).toMatchObject({ ok: false, error: { code: "busy" } });
  });
});

describe("decide: side chats on a shared checkout", () => {
  it("a side chat can be deleted while its parent lives; its event names no worktree or branch", () => {
    const base = withThread("claude", true);
    const { model, sideId } = side(base.model, base.threadId);
    const { events } = run(model, { type: "thread.delete", threadId: sideId });
    const deleted = eventOf(events, "thread.deleted");
    expect(deleted.threadId).toBe(sideId);
    expect(deleted.worktreePath).toBeUndefined();
    expect(deleted.branch).toBeUndefined();
  });

  it("the owner keeps refusing deletion while a side chat lives; a cascade takes both, the owner's event carries the checkout", () => {
    const base = withThread("claude", true);
    const { model, sideId } = side(base.model, base.threadId);
    expect(tryRun(model, { type: "thread.delete", threadId: base.threadId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const { events } = run(model, { type: "thread.delete", threadId: base.threadId, cascade: true });
    const byId = new Map(events.flatMap((e) => (e.type === "thread.deleted" ? [[e.threadId, e] as const] : [])));
    expect(byId.get(sideId)?.worktreePath).toBeUndefined();
    expect(byId.get(base.threadId)).toMatchObject({ worktreePath: "/wt/thread", branch: "tide/login" });
  });

  it("an owner whose worktree a live non-descendant shares still refuses deletion", () => {
    const base = withThread("claude", true);
    const { model, sideId } = side(base.model, base.threadId);
    // a side chat whose lineage link is gone: only the shared checkout keeps the owner alive
    const { parentThreadId: _dropped, ...detached } = model.threads[sideId] as Thread;
    const orphan: ReadModel = { ...model, threads: { ...model.threads, [sideId]: detached } };
    expect(tryRun(orphan, { type: "thread.delete", threadId: base.threadId })).toMatchObject({ ok: false, error: { code: "conflict", message: expect.stringContaining("shares the worktree") } });
  });

  it("rollback with restoreFiles is refused for a side chat; without it is allowed", () => {
    const base = withThread("claude", true);
    const { model, sideId } = side(base.model, base.threadId);
    const t = completeTurn(model, sideId, "ask", "answer");
    expect(tryRun(t.model, { type: "thread.rollback", threadId: sideId, turnId: t.turnId, restoreFiles: true })).toMatchObject({ ok: false, error: { code: "invalid-command" } });
    expect(tryRun(t.model, { type: "thread.rollback", threadId: sideId, turnId: t.turnId, restoreFiles: false })).toMatchObject({ ok: true });
  });
});
