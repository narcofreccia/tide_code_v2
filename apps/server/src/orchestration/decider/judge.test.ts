import { describe, expect, it } from "vitest";
import type { Verdict } from "@tide/contracts";
import { completeTurn, eventOf, run, startTurn, tryRun, withThread } from "./r4.fixtures.ts";

const verdict: Verdict = { site: "stuck", label: "true", score: 0.9, confidence: 0.92, source: "jev", at: 5 };
const judge = { kept: 2, dropped: 1, source: "jev" as const, confidence: 0.9, at: 7 };

function withPendingHandoff(): { model: ReturnType<typeof withThread>["model"]; threadId: string; handoffId: string; turnIds: string[] } {
  const base = withThread("claude");
  const a = completeTurn(base.model, base.threadId, "fix the login", "done");
  const b = completeTurn(a.model, base.threadId, "add tests", "added");
  const switched = run(b.model, { type: "thread.update", threadId: base.threadId, provider: "codex" });
  const handoffId = eventOf(switched.events, "handoff.recorded").handoff.id;
  return { model: switched.model, threadId: base.threadId, handoffId, turnIds: [a.turnId, b.turnId] };
}

describe("decide: judge.record", () => {
  it("lands a verdict on a thread", () => {
    const base = withThread();
    const { model, events } = run(base.model, { type: "judge.record", target: { kind: "thread", id: base.threadId }, verdict });
    expect(eventOf(events, "judge.recorded")).toMatchObject({ target: { kind: "thread", id: base.threadId }, verdict });
    expect(model.threads[base.threadId]?.judge).toEqual(verdict);
  });

  it("lands a verdict on an approval activity, refuses other activities", () => {
    const base = withThread();
    const live = startTurn(base.model, base.threadId, "work");
    let model = run(live.model, {
      type: "activity.upsert",
      activity: { id: "ap1", threadId: base.threadId, turnId: live.turnId, createdAt: 1, updatedAt: 1, kind: "approval", requestId: "r", toolName: "Bash", input: {}, status: "pending" },
    }).model;
    model = run(model, { type: "activity.upsert", activity: { id: "info1", threadId: base.threadId, turnId: live.turnId, createdAt: 1, updatedAt: 1, kind: "info", text: "hi" } }).model;
    const v: Verdict = { ...verdict, site: "approvals", label: "routine" };
    const next = run(model, { type: "judge.record", target: { kind: "approval", id: "ap1" }, verdict: v }).model;
    const ap = next.activities["ap1"];
    expect(ap?.kind === "approval" ? ap.judge : undefined).toEqual(v);
    expect(tryRun(model, { type: "judge.record", target: { kind: "approval", id: "info1" }, verdict: v })).toMatchObject({ ok: false, error: { code: "invalid-command" } });
  });

  it("refuses unknown targets", () => {
    const base = withThread();
    for (const kind of ["thread", "approval", "experts"] as const) {
      expect(tryRun(base.model, { type: "judge.record", target: { kind, id: "nope" }, verdict })).toMatchObject({ ok: false, error: { code: "not-found" } });
    }
  });
});

describe("decide: handoff.refine", () => {
  it("replaces the pending handoff's selection", () => {
    const h = withPendingHandoff();
    const { model, events } = run(h.model, { type: "handoff.refine", handoffId: h.handoffId, text: "refined", coveredTurnIds: [h.turnIds[1] as string], omittedTurnIds: [h.turnIds[0] as string], judge });
    expect(eventOf(events, "handoff.refined")).toMatchObject({ handoffId: h.handoffId, threadId: h.threadId, text: "refined" });
    expect(model.handoffs[h.handoffId]).toMatchObject({ text: "refined", coveredTurnIds: [h.turnIds[1]], omittedTurnIds: [h.turnIds[0]], judge });
  });

  it("refuses an unknown handoff and one a turn already delivered", () => {
    const h = withPendingHandoff();
    const cmd = { type: "handoff.refine" as const, handoffId: h.handoffId, text: "x", coveredTurnIds: [], omittedTurnIds: [], judge };
    expect(tryRun(h.model, { ...cmd, handoffId: "nope" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    const taken = run(h.model, { type: "turn.request", threadId: h.threadId, text: "go on" });
    // taken but not delivered yet: the turn may still be waiting for the judge
    expect(tryRun(taken.model, cmd)).toMatchObject({ ok: true });
    const turnId = eventOf(taken.events, "turn.requested").turn.id;
    const delivered = run(taken.model, { type: "handoff.delivered", turnId, delivery: "inline" }).model;
    expect(tryRun(delivered, cmd)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("decide: thread.update autoAllowRoutine", () => {
  it("passes the opt-in through", () => {
    const base = withThread();
    const { model, events } = run(base.model, { type: "thread.update", threadId: base.threadId, autoAllowRoutine: true });
    expect(eventOf(events, "thread.updated").patch).toEqual({ autoAllowRoutine: true });
    expect(model.threads[base.threadId]?.autoAllowRoutine).toBe(true);
  });
});
