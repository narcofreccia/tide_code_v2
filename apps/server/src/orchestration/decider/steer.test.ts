import { describe, expect, it } from "vitest";
import { completeTurn, eventOf, run, startTurn, tryRun, withThread } from "./r4.fixtures.ts";

const img = { mediaType: "image/png", data: "AAAA" };

describe("decide: turn.request (R4)", () => {
  it("carries the pending handoff and the notification", () => {
    const base = withThread("claude");
    const first = completeTurn(base.model, base.threadId, "fix the login", "done");
    const switched = run(first.model, { type: "thread.update", threadId: base.threadId, provider: "codex" });
    const handoffId = eventOf(switched.events, "handoff.recorded").handoff.id;
    expect(switched.model.threads[base.threadId]?.pendingHandoffId).toBe(handoffId);
    const { model, events } = run(switched.model, {
      type: "turn.request",
      threadId: base.threadId,
      text: "go on",
      notification: { source: "pr", summary: "CI failed" },
    });
    const req = eventOf(events, "turn.requested");
    expect(req.turn.handoffId).toBe(handoffId);
    expect(req.userMessage.notification).toEqual({ source: "pr", summary: "CI failed" });
    expect(model.threads[base.threadId]?.pendingHandoffId).toBeUndefined();
  });
});

describe("decide: turn.steer", () => {
  it("lands a steer message in the live turn", () => {
    const base = withThread();
    const live = startTurn(base.model, base.threadId, "work");
    const { model, events } = run(live.model, { type: "turn.steer", threadId: base.threadId, text: "also tests", images: [img] });
    const steered = eventOf(events, "turn.steered");
    expect(steered).toMatchObject({ turnId: live.turnId, threadId: base.threadId, images: [img] });
    expect(steered.message).toMatchObject({ role: "user", turnId: live.turnId, text: "also tests", steer: true, attachments: [{ mediaType: "image/png", bytes: 3 }] });
    expect(model.messages[steered.message.id]?.steer).toBe(true);
  });

  it("refuses when nothing is running", () => {
    const base = withThread();
    expect(tryRun(base.model, { type: "turn.steer", threadId: base.threadId, text: "x" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(tryRun(base.model, { type: "turn.steer", threadId: "nope", text: "x" })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});

describe("decide: steer.fallback", () => {
  it("turns the steer into a queued turn while the thread runs", () => {
    const base = withThread();
    const live = startTurn(base.model, base.threadId, "work");
    const steered = run(live.model, { type: "turn.steer", threadId: base.threadId, text: "and docs" });
    const { model } = steered;
    const messageId = eventOf(steered.events, "turn.steered").message.id;
    const { model: next, events } = run(model, { type: "steer.fallback", messageId, reason: "no steer cap" });
    const fell = eventOf(events, "turn.steer-fell-back");
    expect(fell.turn.status).toBe("queued");
    expect(fell.userMessage).toMatchObject({ text: "and docs", turnId: fell.turn.id, role: "user" });
    expect(fell.userMessage.id).not.toBe(messageId);
    expect(fell.userMessage.steer).toBeUndefined();
    expect(next.messages[messageId]).toBeUndefined();
    expect(next.turns[fell.turn.id]?.status).toBe("queued");
  });

  it("takes the thread when it is no longer running", () => {
    const base = withThread();
    const live = startTurn(base.model, base.threadId, "work");
    const steered = run(live.model, { type: "turn.steer", threadId: base.threadId, text: "late" });
    const messageId = eventOf(steered.events, "turn.steered").message.id;
    const settled = run(steered.model, { type: "turn.settle", turnId: live.turnId, status: "completed" }).model;
    const { model, events } = run(settled, { type: "steer.fallback", messageId, reason: "turn ended" });
    const fell = eventOf(events, "turn.steer-fell-back");
    expect(fell.turn.status).toBe("requested");
    expect(model.threads[base.threadId]).toMatchObject({ status: "running", latestTurnId: fell.turn.id });
  });

  it("rejects unknown and non-steer messages", () => {
    const base = withThread();
    const live = startTurn(base.model, base.threadId, "work");
    const prompt = Object.values(live.model.messages).find((m) => m.role === "user");
    expect(tryRun(live.model, { type: "steer.fallback", messageId: "nope", reason: "x" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(tryRun(live.model, { type: "steer.fallback", messageId: prompt?.id ?? "", reason: "x" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

/** A running turn with two follow-ups queued behind it. */
function withQueue() {
  const base = withThread();
  const live = startTurn(base.model, base.threadId, "work");
  const a = run(live.model, { type: "turn.request", threadId: base.threadId, text: "first" });
  const b = run(a.model, { type: "turn.request", threadId: base.threadId, text: "second" });
  return {
    model: b.model,
    threadId: base.threadId,
    liveId: live.turnId,
    aId: eventOf(a.events, "turn.requested").turn.id,
    bId: eventOf(b.events, "turn.requested").turn.id,
  };
}

describe("decide: queue editing", () => {
  it("edits a queued turn's prompt", () => {
    const q = withQueue();
    const { model, events } = run(q.model, { type: "turn.edit", turnId: q.aId, text: "first, better" });
    const edited = eventOf(events, "turn.edited");
    expect(model.messages[edited.messageId]).toMatchObject({ turnId: q.aId, text: "first, better" });
  });

  it("refuses to edit a turn that is not queued", () => {
    const q = withQueue();
    expect(tryRun(q.model, { type: "turn.edit", turnId: q.liveId, text: "x" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(tryRun(q.model, { type: "turn.edit", turnId: "nope", text: "x" })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("reorders the queue", () => {
    const q = withQueue();
    const { model } = run(q.model, { type: "turn.reorder", threadId: q.threadId, turnIds: [q.bId, q.aId] });
    expect(model.turns[q.bId]!.requestedAt).toBeLessThan(model.turns[q.aId]!.requestedAt);
  });

  it("rejects a reorder that is not exactly the queue", () => {
    const q = withQueue();
    for (const turnIds of [[q.aId], [q.aId, q.aId], [q.aId, q.bId, q.liveId], [q.aId, "nope"]]) {
      expect(tryRun(q.model, { type: "turn.reorder", threadId: q.threadId, turnIds })).toMatchObject({ ok: false, error: { code: "invalid-command" } });
    }
  });

  it("promotes a queued turn into the running one", () => {
    const q = withQueue();
    const { model, events } = run(q.model, { type: "turn.promote", turnId: q.bId });
    expect(events.map((e) => e.type)).toEqual(["turn.dequeued", "turn.steered"]);
    const steered = eventOf(events, "turn.steered");
    expect(steered.message).toMatchObject({ turnId: q.liveId, text: "second", steer: true });
    expect(model.turns[q.bId]).toBeUndefined();
  });

  it("refuses to promote when nothing runs, or a turn that is not queued", () => {
    const q = withQueue();
    expect(tryRun(q.model, { type: "turn.promote", turnId: q.liveId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const thread = q.model.threads[q.threadId]!;
    const idle = { ...q.model, threads: { ...q.model.threads, [q.threadId]: { ...thread, status: "idle" as const } } };
    expect(tryRun(idle, { type: "turn.promote", turnId: q.aId })).toMatchObject({ ok: false, error: { code: "conflict", message: "nothing is running; the turn will start on its own" } });
  });

  it("refuses a queued turn that carries images", () => {
    const base = withThread();
    const live = startTurn(base.model, base.threadId, "work");
    const a = run(live.model, { type: "turn.request", threadId: base.threadId, text: "look", images: [img] });
    const turnId = eventOf(a.events, "turn.requested").turn.id;
    expect(tryRun(a.model, { type: "turn.promote", turnId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("decide: handoff.delivered", () => {
  it("records how the turn's handoff reached the harness", () => {
    const base = withThread("claude");
    const first = completeTurn(base.model, base.threadId, "fix the login", "done");
    const switched = run(first.model, { type: "thread.update", threadId: base.threadId, provider: "codex" });
    const handoffId = eventOf(switched.events, "handoff.recorded").handoff.id;
    const req = run(switched.model, { type: "turn.request", threadId: base.threadId, text: "go on" });
    const turnId = eventOf(req.events, "turn.requested").turn.id;
    const { model, events } = run(req.model, { type: "handoff.delivered", turnId, delivery: "inline" });
    expect(eventOf(events, "handoff.delivered")).toMatchObject({ turnId, handoffId, delivery: "inline" });
    expect(model.turns[turnId]?.handoffDelivery).toBe("inline");
    expect(tryRun(model, { type: "handoff.delivered", turnId: first.turnId, delivery: "native" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
