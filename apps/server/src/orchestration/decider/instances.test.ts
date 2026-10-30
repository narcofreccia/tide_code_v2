import { describe, expect, it } from "vitest";
import { completeTurn, ctx, eventOf, run, tryRun, withThread } from "./r4.fixtures.ts";

/** A claude thread (default instance) with one settled turn on session "claude-sess". */
function withHistory() {
  const base = withThread("claude");
  const t1 = completeTurn(base.model, base.threadId, "fix the login form", "patched login.ts", "claude-sess");
  return { model: t1.model, threadId: base.threadId, t1: t1.turnId };
}

function withInstances<T>(fn: () => T): T {
  ctx.providerInstances = [
    { id: "claude:work", kind: "claude" },
    { id: "codex:work", kind: "codex" },
  ];
  try {
    return fn();
  } finally {
    delete ctx.providerInstances;
  }
}

describe("decide: provider instances (R8)", () => {
  it("creates a thread on a configured instance with an effort; the default instance stays implicit", () =>
    withInstances(() => {
      const base = withThread("claude");
      const projectId = base.model.threads[base.threadId]!.projectId;
      const onWork = run(base.model, { type: "thread.create", projectId, provider: "claude", providerId: "claude:work", effort: "high" });
      expect(eventOf(onWork.events, "thread.created").thread).toMatchObject({ provider: "claude", providerId: "claude:work", effort: "high" });
      const onDefault = run(base.model, { type: "thread.create", projectId, provider: "claude", providerId: "claude" });
      expect(eventOf(onDefault.events, "thread.created").thread.providerId).toBeUndefined();
    }));

  it("refuses an unknown instance or one of another kind", () =>
    withInstances(() => {
      const base = withThread("claude");
      const projectId = base.model.threads[base.threadId]!.projectId;
      expect(tryRun(base.model, { type: "thread.create", projectId, provider: "claude", providerId: "claude:ghost" })).toMatchObject({ ok: false, error: { code: "invalid-command" } });
      expect(tryRun(base.model, { type: "thread.create", projectId, provider: "claude", providerId: "codex:work" })).toMatchObject({ ok: false, error: { code: "invalid-command" } });
      expect(tryRun(base.model, { type: "thread.update", threadId: base.threadId, providerId: "nope" })).toMatchObject({ ok: false, error: { code: "invalid-command" } });
    }));

  it("an instance switch within one kind starts fresh with a full handoff", () =>
    withInstances(() => {
      const h = withHistory();
      const withModel = run(h.model, { type: "thread.update", threadId: h.threadId, model: "opus", effort: "high" }).model;
      const { model, events } = run(withModel, { type: "thread.update", threadId: h.threadId, providerId: "claude:work" });
      const updated = eventOf(events, "thread.updated");
      expect(updated).toMatchObject({ patch: { provider: "claude", providerId: "claude:work" }, clearNativeSession: true, clearModel: true, clearEffort: true });
      const { handoff } = eventOf(events, "handoff.recorded");
      expect(handoff).toMatchObject({ fromProvider: "claude", toProvider: "claude", strategy: "full", coveredTurnIds: [h.t1] });
      const thread = model.threads[h.threadId]!;
      expect(thread).toMatchObject({ provider: "claude", providerId: "claude:work" });
      expect(thread.nativeSessionId).toBeUndefined();
      expect(thread.model).toBeUndefined();
      expect(thread.effort).toBeUndefined();
    }));

  it("naming an instance of another kind switches the kind too; naming the old kind goes back to its default", () =>
    withInstances(() => {
      const h = withHistory();
      const toCodex = run(h.model, { type: "thread.update", threadId: h.threadId, providerId: "codex:work" });
      expect(toCodex.model.threads[h.threadId]).toMatchObject({ provider: "codex", providerId: "codex:work" });
      const t2 = completeTurn(toCodex.model, h.threadId, "rename the helper", "renamed", "codex-sess");
      const back = run(t2.model, { type: "thread.update", threadId: h.threadId, provider: "claude" });
      const updated = eventOf(back.events, "thread.updated");
      // the default claude instance ran it before: its own session comes back with only the delta
      expect(updated).toMatchObject({ patch: { provider: "claude", providerId: "claude" }, nativeSessionId: "claude-sess" });
      expect(eventOf(back.events, "handoff.recorded").handoff).toMatchObject({ strategy: "delta", coveredTurnIds: [t2.turnId] });
    }));

  it("is busy while running and a no-op switch to the same instance is a plain update", () =>
    withInstances(() => {
      const h = withHistory();
      const same = run(h.model, { type: "thread.update", threadId: h.threadId, providerId: "claude", title: "x" });
      expect(same.events.map((e) => e.type)).toEqual(["thread.updated"]);
      expect(eventOf(same.events, "thread.updated").clearNativeSession).toBeUndefined();
      const live = run(h.model, { type: "turn.request", threadId: h.threadId, text: "go" }).model;
      expect(tryRun(live, { type: "thread.update", threadId: h.threadId, providerId: "claude:work" })).toMatchObject({ ok: false, error: { code: "busy" } });
    }));

  it('sets effort, and "" clears it back to the harness default', () => {
    const h = withHistory();
    const set = run(h.model, { type: "thread.update", threadId: h.threadId, effort: "medium" });
    expect(set.model.threads[h.threadId]?.effort).toBe("medium");
    const cleared = run(set.model, { type: "thread.update", threadId: h.threadId, effort: "" });
    expect(eventOf(cleared.events, "thread.updated")).toMatchObject({ clearEffort: true, patch: {} });
    expect(cleared.model.threads[h.threadId]?.effort).toBeUndefined();
  });

  it("delegates onto an instance and reads its providerDefaults before the kind's", () =>
    withInstances(() => {
      const h = withHistory();
      ctx.providerDefaults = { "codex:work": { model: "gpt-work" }, codex: { model: "gpt-default" } };
      try {
        const out = run(h.model, { type: "thread.delegate", fromThreadId: h.threadId, provider: "codex", prompt: "review", useWorktree: false, ...{ providerId: "codex:work" } });
        expect(eventOf(out.events, "thread.created").thread).toMatchObject({ provider: "codex", providerId: "codex:work", model: "gpt-work" });
        const plain = run(h.model, { type: "thread.delegate", fromThreadId: h.threadId, provider: "codex", prompt: "review", useWorktree: false });
        expect(eventOf(plain.events, "thread.created").thread.model).toBe("gpt-default");
      } finally {
        delete ctx.providerDefaults;
      }
    }));
});
