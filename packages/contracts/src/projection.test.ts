import { describe, it, expect } from "vitest";
import { emptyReadModel, replay, applyRecord, type EventRecord } from "./index.ts";

const rec = (seq: number, event: EventRecord["event"]): EventRecord => ({ seq, ts: seq, event });

describe("projection", () => {
  it("replays project/thread/turn lifecycle", () => {
    const m = replay(emptyReadModel(), [
      rec(1, { type: "project.created", project: { id: "p1", title: "T", rootPath: "/x", createdAt: 1, updatedAt: 1 } }),
      rec(2, { type: "thread.created", thread: { id: "t1", projectId: "p1", title: "New", provider: "claude", mode: "approval-required", interaction: "default", status: "idle", createdAt: 2, updatedAt: 2 } }),
      rec(3, { type: "turn.requested", turn: { id: "u1", threadId: "t1", status: "requested", requestedAt: 3 }, userMessage: { id: "m1", threadId: "t1", turnId: "u1", role: "user", text: "hi", createdAt: 3 } }),
      rec(4, { type: "assistant.delta", turnId: "u1", threadId: "t1", messageId: "m2", delta: "hel", at: 4 }),
      rec(5, { type: "assistant.delta", turnId: "u1", threadId: "t1", messageId: "m2", delta: "lo", at: 5 }),
      rec(6, { type: "turn.settled", turnId: "u1", threadId: "t1", status: "completed", settledAt: 6 }),
    ]);
    expect(m.seq).toBe(6);
    expect(m.threads["t1"]?.status).toBe("idle");
    expect(m.threadMessages["t1"]).toEqual(["m1", "m2"]);
    expect(m.messages["m2"]).toMatchObject({ text: "hello", streaming: false });
    expect(m.turns["u1"]?.status).toBe("completed");
  });
  it("ignores already-applied seqs", () => {
    const base = replay(emptyReadModel(), [rec(1, { type: "project.created", project: { id: "p1", title: "T", rootPath: "/x", createdAt: 1, updatedAt: 1 } })]);
    const again = applyRecord(base, rec(1, { type: "project.archived", projectId: "p1", archivedAt: 9 }));
    expect(again).toBe(base);
  });
});
