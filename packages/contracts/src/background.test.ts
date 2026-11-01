import { describe, expect, it } from "vitest";
import { applyRecord } from "./projection.ts";
import { backgroundChildren, hasBackgroundChildren } from "./background.ts";
import { emptyReadModel, type Activity, type ReadModel } from "./domain.ts";
import type { DomainEvent } from "./events.ts";

let seq = 0;
const apply = (model: ReadModel, ...events: DomainEvent[]): ReadModel =>
  events.reduce((m, event) => applyRecord(m, { seq: ++seq, ts: seq, event }), model);

const thread: DomainEvent = {
  type: "thread.created",
  thread: { id: "t1", projectId: "p1", title: "t1", provider: "claude", mode: "approval-required", interaction: "default", status: "idle", createdAt: 1, updatedAt: 1 },
};
const turn = (turnId: string, at: number): DomainEvent[] => [
  { type: "turn.requested", turn: { id: turnId, threadId: "t1", status: "requested", requestedAt: at }, userMessage: { id: `${turnId}-u`, threadId: "t1", turnId, role: "user", text: "go", createdAt: at } },
  { type: "turn.started", turnId, threadId: "t1", provider: "claude", startedAt: at },
];
const settle = (turnId: string, at: number): DomainEvent => ({ type: "turn.settled", turnId, threadId: "t1", status: "completed", settledAt: at });
const child = (id: string, turnId: string, status: "running" | "done" | "error", at = 10): DomainEvent => ({
  type: "activity.upserted",
  activity: { id, threadId: "t1", turnId, kind: "child", childKey: id, name: id, status, createdAt: at, updatedAt: at } as Activity,
});

describe("backgroundChildren", () => {
  it("counts a running child of a settled turn", () => {
    const m = apply(emptyReadModel(), thread, ...turn("u1", 5), child("c1", "u1", "running"), settle("u1", 20));
    expect(backgroundChildren(m, "t1").map((c) => c.id)).toEqual(["c1"]);
    expect(hasBackgroundChildren(m, "t1")).toBe(true);
  });

  it("does not count a child of the turn in flight, nor a finished one", () => {
    const m = apply(emptyReadModel(), thread, ...turn("u1", 5), child("c1", "u1", "running"), child("c2", "u1", "done"));
    expect(hasBackgroundChildren(m, "t1")).toBe(false);
  });

  it("keeps an earlier turn's child while a new turn runs, oldest first", () => {
    const m = apply(emptyReadModel(), thread, ...turn("u1", 5), child("c2", "u1", "running", 12), child("c1", "u1", "running", 11), settle("u1", 20), ...turn("u2", 30));
    expect(backgroundChildren(m, "t1").map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("is empty for an unknown thread", () => {
    expect(backgroundChildren(emptyReadModel(), "nope")).toEqual([]);
  });
});
