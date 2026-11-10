import { describe, expect, it } from "vitest";
import { decide } from "./index.ts";
import { completeTurn, ctx, eventOf, run, startTurn, tryRun, withThread } from "./r4.fixtures.ts";

describe("decide: turn.request freshSession (R17 T1)", () => {
  it("emits the requested turn marked fresh, then the boundary for the thread's instance", () => {
    const f = withThread("claude");
    const t1 = completeTurn(f.model, f.threadId, "first", "ok", "claude-sess");
    const { model, events } = run(t1.model, { type: "turn.request", threadId: f.threadId, text: "start over", freshSession: true });
    expect(events.map((e) => e.type)).toEqual(["turn.requested", "session.boundary"]);
    const requested = eventOf(events, "turn.requested");
    expect(requested.turn).toMatchObject({ status: "requested", freshSession: true });
    expect(eventOf(events, "session.boundary")).toEqual({ type: "session.boundary", threadId: f.threadId, turnId: requested.turn.id, providerId: "claude", at: ctx.now });
    expect(model.threads[f.threadId]).toMatchObject({ sessionBoundaryTurnId: requested.turn.id });
    expect(model.threads[f.threadId]?.nativeSessionId).toBeUndefined();
  });

  it("a first prompt still titles the thread ahead of the two events", () => {
    const f = withThread("claude");
    const untitled = run(f.model, { type: "thread.update", threadId: f.threadId, title: "New thread" }).model;
    const { events } = run(untitled, { type: "turn.request", threadId: f.threadId, text: "fix the login form", freshSession: true });
    expect(events.slice(-2).map((e) => e.type)).toEqual(["turn.requested", "session.boundary"]);
  });

  it("is refused while a turn runs (a queued fresh turn would close the live session)", () => {
    const f = withThread("claude");
    const live = startTurn(f.model, f.threadId, "work");
    expect(tryRun(live.model, { type: "turn.request", threadId: f.threadId, text: "again", freshSession: true })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("a pending handoff rides along with a fresh session (switch provider + clear)", () => {
    const f = withThread("claude");
    const t1 = completeTurn(f.model, f.threadId, "first", "ok", "claude-sess");
    const switched = run(t1.model, { type: "thread.update", threadId: f.threadId, provider: "codex" }).model;
    const handoffId = switched.threads[f.threadId]?.pendingHandoffId;
    expect(handoffId).toBeDefined();
    const { events } = run(switched, { type: "turn.request", threadId: f.threadId, text: "go", freshSession: true });
    expect(eventOf(events, "turn.requested").turn).toMatchObject({ handoffId, freshSession: true });
    expect(eventOf(events, "session.boundary").providerId).toBe("codex");
  });
});

describe("decide: turn.start freshSession — a resume that did not hold (R18 D1)", () => {
  it("records the boundary before turn.started and lands the new native id on a cleared thread", () => {
    const f = withThread("claude");
    const t1 = completeTurn(f.model, f.threadId, "first", "ok", "old-sess");
    const requested = run(t1.model, { type: "turn.request", threadId: f.threadId, text: "next" });
    const turnId = eventOf(requested.events, "turn.requested").turn.id;
    const { model, events } = run(requested.model, { type: "turn.start", turnId, provider: "claude", nativeSessionId: "new-sess", freshSession: true });
    expect(events.map((e) => e.type)).toEqual(["session.boundary", "turn.started"]);
    expect(model.threads[f.threadId]).toMatchObject({ sessionBoundaryTurnId: turnId, nativeSessionId: "new-sess" });
  });

  it("adds no second boundary to a turn the user already asked to start fresh", () => {
    const f = withThread("claude");
    const t1 = completeTurn(f.model, f.threadId, "first", "ok", "old-sess");
    const requested = run(t1.model, { type: "turn.request", threadId: f.threadId, text: "again", freshSession: true });
    const turnId = eventOf(requested.events, "turn.requested").turn.id;
    const { events } = run(requested.model, { type: "turn.start", turnId, provider: "claude", freshSession: true });
    expect(events.map((e) => e.type)).toEqual(["turn.started"]);
  });
});

describe("decide: plan mode against cached caps (R17 C1)", () => {
  const caps = { providerCaps: { pi: { planMode: false, label: "Pi" }, claude: { planMode: true } } };

  it("refuses plan mode on an instance whose caps say no; unknown instances are unchecked", () => {
    const f = withThread("claude");
    const projectId = f.model.threads[f.threadId]?.projectId as string;
    const create = (provider: "pi" | "claude" | "codex") => decide(f.model, { type: "thread.create", projectId, provider, interaction: "plan" }, { ...ctx, ...caps });
    expect(create("pi")).toMatchObject({ ok: false, error: { code: "invalid-command", message: "Pi does not support plan mode" } });
    expect(create("claude")).toMatchObject({ ok: true });
    expect(create("codex")).toMatchObject({ ok: true });
    expect(decide(f.model, { type: "thread.create", projectId, provider: "pi", interaction: "plan" }, ctx)).toMatchObject({ ok: true });
  });

  it("checks thread.update against the instance the thread ends up on", () => {
    const f = withThread("claude");
    const update = (patch: Record<string, unknown>) => decide(f.model, { type: "thread.update", threadId: f.threadId, interaction: "plan", ...patch } as never, { ...ctx, ...caps });
    expect(update({})).toMatchObject({ ok: true });
    expect(update({ provider: "pi" })).toMatchObject({ ok: false, error: { code: "invalid-command" } });
  });
});
