import { afterEach, describe, expect, it } from "vitest";
import { emptyReadModel } from "@tide/contracts";
import { activityCount, isUnread, LAST_SEEN_KEY, markSeen, resetLastSeen, useLastSeen } from "./lastSeen.ts";
import { makeThread } from "../testHarness.ts";

afterEach(() => {
  resetLastSeen();
  window.localStorage.clear();
});

describe("lastSeen", () => {
  it("counts timeline entries, falling back to messages", () => {
    const m = emptyReadModel();
    m.threadMessages.t1 = ["a", "b"];
    expect(activityCount(m, "t1")).toBe(2);
    m.threadTimeline.t1 = [{ kind: "message", id: "a" }, { kind: "message", id: "b" }, { kind: "plan", id: "p" }];
    expect(activityCount(m, "t1")).toBe(3);
    expect(activityCount(m, "nope")).toBe(0);
  });

  it("is unread only for activity after the last look", () => {
    resetLastSeen(100);
    const t = makeThread("t1", { updatedAt: 200 });
    // never opened: unread when it moved after tracking started
    expect(isUnread(t, 2, useLastSeen.getState(), null)).toBe(true);
    expect(isUnread({ ...t, updatedAt: 50 }, 2, useLastSeen.getState(), null)).toBe(false);
    markSeen("t1", 2);
    expect(isUnread(t, 2, useLastSeen.getState(), null)).toBe(false);
    expect(isUnread(t, 3, useLastSeen.getState(), null)).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(LAST_SEEN_KEY) ?? "{}").seen).toEqual({ t1: 2 });
  });

  it("never marks the open, a running, a settled or an archived thread", () => {
    resetLastSeen(0);
    const s = useLastSeen.getState();
    const t = makeThread("t1", { updatedAt: 5 });
    expect(isUnread(t, 1, s, "t1")).toBe(false);
    expect(isUnread({ ...t, status: "running" }, 1, s, null)).toBe(false);
    expect(isUnread({ ...t, settledAt: 1 }, 1, s, null)).toBe(false);
    expect(isUnread({ ...t, archivedAt: 1 }, 1, s, null)).toBe(false);
  });
});
