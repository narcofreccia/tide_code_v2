import { describe, expect, it } from "vitest";
import { applyRecord, emptyReadModel, type DomainEvent, type ReadModel } from "@tide/contracts";
import { selectThreadTurnsStable, selectTimeline, selectTimelineStable } from "./selectors.ts";

function build(events: DomainEvent[]): ReadModel {
  return events.reduce((model, event, i) => applyRecord(model, { seq: i + 1, ts: i, event }), emptyReadModel());
}

const thread = (id: string): DomainEvent => ({
  type: "thread.created",
  thread: { id, projectId: "p1", title: id, provider: "claude", mode: "approval-required", interaction: "default", status: "idle", createdAt: 1, updatedAt: 1 },
});

function turn(threadId: string): DomainEvent[] {
  const turnId = `${threadId}-turn`;
  return [
    { type: "turn.requested", turn: { id: turnId, threadId, status: "requested", requestedAt: 2 }, userMessage: { id: `${turnId}-u`, threadId, turnId, role: "user", text: "go", createdAt: 2 } },
    { type: "turn.started", turnId, threadId, provider: "claude", startedAt: 3 },
    { type: "assistant.delta", turnId, threadId, messageId: `${turnId}-a`, delta: "hi", at: 4 },
  ];
}

const delta = (threadId: string, seq: number): { seq: number; ts: number; event: DomainEvent } => ({
  seq,
  ts: seq,
  event: { type: "assistant.delta", turnId: `${threadId}-turn`, threadId, messageId: `${threadId}-turn-a`, delta: " more", at: seq },
});

describe("stable per-thread selectors", () => {
  const base = build([thread("a"), thread("b"), ...turn("a"), ...turn("b")]);

  it("selectTimelineStable matches selectTimeline", () => {
    expect(selectTimelineStable(base, "a")).toEqual(selectTimeline(base, "a"));
  });

  it("keeps the same timeline array for a delta on another thread, a new one for this thread", () => {
    const first = selectTimelineStable(base, "a");
    const other = applyRecord(base, delta("b", base.seq + 1));
    expect(selectTimelineStable(other, "a")).toBe(first);
    const own = applyRecord(other, delta("a", other.seq + 1));
    const next = selectTimelineStable(own, "a");
    expect(next).not.toBe(first);
    // the unchanged user message keeps its item object
    expect(next[0]).toBe(first[0]);
    expect(next[1]?.kind === "message" && next[1].message.text).toBe("hi more");
  });

  it("keeps the same turns array until this thread's turns change", () => {
    const first = selectThreadTurnsStable(base, "a");
    expect(first.map((t) => t.id)).toEqual(["a-turn"]);
    const settledB = applyRecord(base, { seq: base.seq + 1, ts: 9, event: { type: "turn.settled", turnId: "b-turn", threadId: "b", status: "completed", settledAt: 9 } });
    expect(selectThreadTurnsStable(settledB, "a")).toBe(first);
    const settledA = applyRecord(settledB, { seq: settledB.seq + 1, ts: 10, event: { type: "turn.settled", turnId: "a-turn", threadId: "a", status: "completed", settledAt: 10 } });
    expect(selectThreadTurnsStable(settledA, "a")).not.toBe(first);
  });
});
