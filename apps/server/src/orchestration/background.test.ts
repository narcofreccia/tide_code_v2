import type { ActivityOf } from "@tide/contracts";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/sqlite.ts";
import { SettingsStore } from "../settings.ts";
import { backgroundActivityAt, lostChildSummary, markChildrenLost } from "./background.ts";
import { CommandError, Engine } from "./engine.ts";
import { recoverLostChildren, recoverUnsettledTurns } from "./recovery.ts";
import { SettlementReactor } from "./settlement.ts";
import { EventStore } from "./store.ts";

const DAY = 86_400_000;
const LOST = lostChildSummary("Claude Code");

type Child = ActivityOf<"child">;

async function setup() {
  const clock = { now: 1_000 };
  const engine = new Engine({ store: new EventStore(await openDatabase(":memory:")), now: () => clock.now });
  const created = (await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
  if (created?.type !== "project.created") throw new Error("expected project");
  const projectId = created.project.id;
  const thread = async (): Promise<string> => {
    const e = (await engine.dispatch({ type: "thread.create", projectId, provider: "claude" })).events[0]?.event;
    if (e?.type !== "thread.created") throw new Error("expected thread");
    return e.thread.id;
  };
  /** a started turn on the thread */
  const turn = async (threadId: string): Promise<string> => {
    const r = await engine.dispatch({ type: "turn.request", threadId, text: "go" });
    const e = r.events.find((x) => x.event.type === "turn.requested")?.event;
    if (e?.type !== "turn.requested") throw new Error("expected turn");
    await engine.dispatch({ type: "turn.start", turnId: e.turn.id, provider: "claude" });
    return e.turn.id;
  };
  const child = async (threadId: string, turnId: string, key: string, status: Child["status"] = "running"): Promise<string> => {
    const id = `child-${key}`;
    await engine.dispatch({
      type: "activity.upsert",
      activity: { id, threadId, turnId, createdAt: clock.now, updatedAt: clock.now, kind: "child", childKey: key, name: `agent ${key}`, status },
    });
    return id;
  };
  const settle = (turnId: string) => engine.dispatch({ type: "turn.settle", turnId, status: "completed" });
  /** a thread whose turn settled while one sub-agent keeps running in the background */
  const backgrounded = async (): Promise<{ threadId: string; turnId: string; childId: string }> => {
    const threadId = await thread();
    const turnId = await turn(threadId);
    const childId = await child(threadId, turnId, "bg");
    await settle(turnId);
    return { threadId, turnId, childId };
  };
  return { engine, clock, thread, turn, child, settle, backgrounded };
}

const childOf = (engine: Engine, id: string): Child => engine.getModel().activities[id] as Child;

describe("auto-settle and background sub-agents", () => {
  it("skips a thread with a background child and counts from its report once it lands", async () => {
    const { engine, clock, backgrounded } = await setup();
    const settings = new SettingsStore();
    settings.set({ inbox: { autoSettleAfterDays: 1 } });
    const reactor = new SettlementReactor({ engine, settings, now: () => clock.now });
    const { threadId, childId } = await backgrounded();
    expect(engine.getModel().threads[threadId]?.status).toBe("idle");

    clock.now += 5 * DAY;
    expect(await reactor.tick()).toEqual([]);

    // the sub-agent reports 5 days in: the clock restarts from its row, not the old settle
    const reported = { ...childOf(engine, childId), status: "done" as const, updatedAt: clock.now };
    await engine.dispatch({ type: "activity.upsert", activity: reported });
    clock.now += DAY / 2;
    expect(await reactor.tick()).toEqual([]);
    clock.now += DAY;
    expect(await reactor.tick()).toEqual([threadId]);
  });

  it("the decider refuses an automatic settle while background work runs, but the user may", async () => {
    const { engine, backgrounded } = await setup();
    const { threadId } = await backgrounded();
    await expect(engine.dispatch({ type: "thread.settle", threadId, reason: "inactive" })).rejects.toBeInstanceOf(CommandError);
    await engine.dispatch({ type: "thread.settle", threadId, reason: "user" });
    expect(engine.getModel().threads[threadId]?.settledAt).toBeDefined();
  });

  it("backgroundActivityAt follows the newest row of the background agents, tool calls included", async () => {
    const { engine, clock, backgrounded } = await setup();
    const { threadId, turnId } = await backgrounded();
    expect(backgroundActivityAt(engine.getModel(), threadId)).toBe(1_000);
    clock.now = 9_000;
    await engine.dispatch({
      type: "activity.upsert",
      activity: { id: "tool-1", threadId, turnId, createdAt: clock.now, updatedAt: clock.now, kind: "tool", toolUseId: "t1", toolName: "Bash", input: {}, status: "running", parentToolUseId: "bg" },
    });
    expect(backgroundActivityAt(engine.getModel(), threadId)).toBe(9_000);
  });
});

describe("lost background sub-agents", () => {
  it("markChildrenLost closes running background children as error, leaves finished ones alone", async () => {
    const { engine, clock, thread, turn, child, settle } = await setup();
    const threadId = await thread();
    const turnId = await turn(threadId);
    const running = await child(threadId, turnId, "a");
    const done = await child(threadId, turnId, "b", "done");
    await settle(turnId);
    clock.now = 5_000;
    expect(await markChildrenLost(engine, threadId)).toBe(1);
    expect(childOf(engine, running)).toMatchObject({ status: "error", summary: LOST, name: "agent a", turnId });
    expect(childOf(engine, done)).toMatchObject({ status: "done" });
    expect(childOf(engine, done).summary).toBeUndefined();
    // idempotent: nothing left running
    expect(await markChildrenLost(engine, threadId)).toBe(0);
  });

  it("never touches a child of the turn in flight (the turn shows it live)", async () => {
    const { engine, thread, turn, child } = await setup();
    const threadId = await thread();
    const turnId = await turn(threadId);
    const live = await child(threadId, turnId, "fg");
    expect(await markChildrenLost(engine, threadId)).toBe(0);
    expect(childOf(engine, live).status).toBe("running");
  });

  it("startup recovery closes children of turns it settles and background children of settled turns", async () => {
    const { engine, thread, turn, child, backgrounded } = await setup();
    const bg = await backgrounded();
    const dead = await thread();
    const deadTurn = await turn(dead);
    const fg = await child(dead, deadTurn, "fg");
    const report = await recoverUnsettledTurns(engine);
    expect(report.turns).toBe(1);
    expect(await recoverLostChildren(engine)).toBe(2);
    expect(childOf(engine, bg.childId)).toMatchObject({ status: "error", summary: LOST });
    expect(childOf(engine, fg)).toMatchObject({ status: "error", summary: LOST });
  });
});
