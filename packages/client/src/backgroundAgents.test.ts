import { describe, expect, it } from "vitest";
import { applyRecord, emptyReadModel, type Activity, type DomainEvent, type ReadModel } from "@tide/contracts";
import { BACKGROUND_QUIET_MS, countBackgroundAgents, selectBackgroundAgents, selectBackgroundAgentsCore } from "./backgroundAgents.ts";
import { selectRailGroups } from "./selectors.ts";

let seq = 0;
function apply(model: ReadModel, ...events: DomainEvent[]): ReadModel {
  return events.reduce((m, event) => applyRecord(m, { seq: ++seq, ts: seq, event }), model);
}

const thread = (id: string): DomainEvent => ({
  type: "thread.created",
  thread: { id, projectId: "p1", title: id, provider: "claude", mode: "approval-required", interaction: "default", status: "idle", createdAt: 1, updatedAt: 1 },
});

function turn(threadId: string, turnId: string, at: number): DomainEvent[] {
  return [
    { type: "turn.requested", turn: { id: turnId, threadId, status: "requested", requestedAt: at }, userMessage: { id: `${turnId}-u`, threadId, turnId, role: "user", text: "go", createdAt: at } },
    { type: "turn.started", turnId, threadId, provider: "claude", startedAt: at },
  ];
}
const settle = (threadId: string, turnId: string, at: number): DomainEvent => ({ type: "turn.settled", turnId, threadId, status: "completed", settledAt: at });

const child = (id: string, over: Partial<Activity> & { childKey?: string; status?: "running" | "done" | "error" } = {}): DomainEvent => ({
  type: "activity.upserted",
  activity: { id, threadId: "t1", turnId: "u1", kind: "child", childKey: id, name: `agent ${id}`, description: "Explore", status: "running", createdAt: 10, updatedAt: 10, ...over } as Activity,
});
const tool = (id: string, parent: string, at: number, input: unknown = { file_path: "/repo/src/skills.py" }, threadId = "t1"): DomainEvent => ({
  type: "activity.upserted",
  activity: { id, threadId, turnId: "u1", kind: "tool", toolUseId: id, toolName: "Read", input, status: "ok", parentToolUseId: parent, createdAt: at, updatedAt: at },
});

/** t1: one settled turn u1 that launched child c1 (still running) */
function idleWithChild(): ReadModel {
  return apply(emptyReadModel(), thread("t1"), thread("t2"), ...turn("t1", "u1", 5), child("c1"), settle("t1", "u1", 20));
}

describe("selectBackgroundAgents", () => {
  it("lists a running child of a settled turn while the thread is idle", () => {
    const m = idleWithChild();
    expect(m.threads["t1"]?.status).toBe("idle");
    const list = selectBackgroundAgents(m, "t1", 70);
    expect(list).toEqual([
      { activityId: "c1", childKey: "c1", threadId: "t1", turnId: "u1", name: "agent c1", description: "Explore", startedAt: 10, lastActivityAt: 10, toolCalls: 0, quietMs: 60 },
    ]);
    expect(countBackgroundAgents(m, "t1")).toBe(1);
    expect(countBackgroundAgents(m, "t2")).toBe(0);
  });

  it("drops a child once it finished", () => {
    const m = apply(idleWithChild(), child("c1", { status: "done", updatedAt: 40 }));
    expect(selectBackgroundAgents(m, "t1", 50)).toEqual([]);
    expect(countBackgroundAgents(m, "t1")).toBe(0);
  });

  it("lists several, oldest first", () => {
    const m = apply(idleWithChild(), child("c0", { createdAt: 8, updatedAt: 8 }), child("c2", { createdAt: 12, updatedAt: 12 }));
    expect(selectBackgroundAgents(m, "t1", 100).map((a) => a.childKey)).toEqual(["c0", "c1", "c2"]);
  });

  it("counts the tool rows under a child and picks the newest one", () => {
    const m = apply(
      idleWithChild(),
      tool("x1", "c1", 30, { command: "pnpm test" }),
      tool("x2", "c1", 50),
      tool("x3", "c1", 40, { pattern: "TODO" }),
      tool("y1", "other", 90),
    );
    const [agent] = selectBackgroundAgents(m, "t1", 58);
    expect(agent?.toolCalls).toBe(3);
    expect(agent?.last).toEqual({ toolName: "Read", target: "skills.py", at: 50 });
    expect(agent?.lastActivityAt).toBe(50);
    expect(agent?.quietMs).toBe(8);
  });

  it("reports a long silence honestly instead of guessing it finished", () => {
    const m = idleWithChild();
    const later = 10 + BACKGROUND_QUIET_MS + 60_000;
    const [agent] = selectBackgroundAgents(m, "t1", later);
    expect(agent?.quietMs).toBe(BACKGROUND_QUIET_MS + 60_000);
    expect(agent?.quietMs).toBeGreaterThan(BACKGROUND_QUIET_MS);
  });

  it("excludes archived threads and rolled-back turns", () => {
    const archived = apply(idleWithChild(), { type: "thread.archived", threadId: "t1", archivedAt: 50 });
    expect(selectBackgroundAgents(archived, "t1", 60)).toEqual([]);
    const base = idleWithChild();
    const rolled: ReadModel = { ...base, turns: { ...base.turns, u1: { ...base.turns["u1"]!, rolledBack: true } } };
    expect(selectBackgroundAgents(rolled, "t1", 60)).toEqual([]);
  });

  it("leaves out children of the turn in flight, keeps older ones", () => {
    const m = apply(idleWithChild(), ...turn("t1", "u2", 30), child("c2", { turnId: "u2", createdAt: 31, updatedAt: 31 }));
    expect(m.threads["t1"]?.status).toBe("running");
    expect(selectBackgroundAgents(m, "t1", 40).map((a) => a.childKey)).toEqual(["c1"]);
  });

  it("keeps identity when nothing relevant changed", () => {
    const m = idleWithChild();
    const first = selectBackgroundAgents(m, "t1", 70);
    expect(selectBackgroundAgents(m, "t1", 70)).toBe(first);
    const core = selectBackgroundAgentsCore(m, "t1");
    // another thread's activity replaces the activities map; t1's agents are unchanged
    const other = apply(m, ...turn("t2", "v1", 30), tool("z1", "nope", 31, {}, "t2"));
    expect(selectBackgroundAgentsCore(other, "t1")).toBe(core);
    expect(selectBackgroundAgents(other, "t1", 70)).toBe(first);
    // a new tool row under the child is a change
    const own = apply(other, tool("x1", "c1", 60));
    expect(selectBackgroundAgentsCore(own, "t1")).not.toBe(core);
    // a new clock is a new list over the same core
    expect(selectBackgroundAgents(own, "t1", 80)).not.toBe(first);
  });

  it("puts an idle thread with background agents in the rail's Working group", () => {
    const m = idleWithChild();
    const groups = selectRailGroups(m, "p1", 100, { workingSection: true });
    expect(groups.working.map((t) => t.id)).toEqual(["t1"]);
    expect(groups.threads.map((t) => t.id)).toEqual(["t2"]);
  });
});
