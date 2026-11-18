import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "./engine.ts";
import { recoverUnsettledTurns, RESTART_ERROR } from "./recovery.ts";
import { EventStore } from "./store.ts";

/** A thread with a running turn and a follow-up queued behind it. */
async function setup(): Promise<{ engine: Engine; threadId: string; projectId: string; liveId: string; queuedId: string }> {
  const engine = new Engine({ store: new EventStore(await openDatabase(":memory:")), now: () => 1_000 });
  const project = (await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project");
  const thread = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
  if (thread?.type !== "thread.created") throw new Error("expected thread");
  const threadId = thread.thread.id;
  const turnOf = async (text: string): Promise<string> => {
    const e = (await engine.dispatch({ type: "turn.request", threadId, text })).events.at(-1)?.event;
    if (e?.type !== "turn.requested") throw new Error("expected a turn");
    return e.turn.id;
  };
  const liveId = await turnOf("go");
  await engine.dispatch({ type: "turn.start", turnId: liveId, provider: "claude" });
  const queuedId = await turnOf("next");
  return { engine, threadId, projectId: project.project.id, liveId, queuedId };
}

async function holdProject(engine: Engine, projectId: string): Promise<void> {
  await engine.dispatch({ type: "quota.set", scope: "project", id: projectId, quota: { sharePct: 10, onExceed: "hold" } });
  await engine.dispatch({ type: "quota.meter", scope: "project", id: projectId, state: { status: "exceeded", usedPct: 120, basis: "share", over: ["claude"], at: 1_000 } });
}

describe("recoverUnsettledTurns: queues with nothing live (R20)", () => {
  it("leaves a queue a quota holds alone", async () => {
    const s = await setup();
    await holdProject(s.engine, s.projectId);
    await s.engine.dispatch({ type: "turn.settle", turnId: s.liveId, status: "completed" });
    const resumed: string[] = [];
    const report = await recoverUnsettledTurns(s.engine, { resume: (_t, turnId) => resumed.push(turnId) });
    expect(report).toMatchObject({ turns: 0, promoted: 0, held: 1 });
    expect(s.engine.getModel().turns[s.queuedId]?.status).toBe("queued");
    expect(resumed).toEqual([]);
  });

  it("leaves a queue a usage limit holds alone", async () => {
    const s = await setup();
    await s.engine.dispatch({ type: "thread.limited", threadId: s.threadId });
    await s.engine.dispatch({ type: "turn.settle", turnId: s.liveId, status: "error", holdQueue: true });
    const report = await recoverUnsettledTurns(s.engine);
    expect(report).toMatchObject({ turns: 0, held: 1 });
    expect(s.engine.getModel().turns[s.queuedId]?.status).toBe("queued");
  });

  it("releases and runs the oldest turn of a queue nothing holds any more", async () => {
    const s = await setup();
    // the previous process stopped between the settle that held the queue and the release
    await s.engine.dispatch({ type: "turn.settle", turnId: s.liveId, status: "error", holdQueue: true });
    const resumed: [string, string][] = [];
    const report = await recoverUnsettledTurns(s.engine, { resume: (threadId, turnId) => resumed.push([threadId, turnId]) });
    expect(report).toMatchObject({ turns: 0, promoted: 1, held: 0 });
    expect(s.engine.getModel().turns[s.queuedId]?.status).toBe("requested");
    expect(s.engine.getModel().threads[s.threadId]).toMatchObject({ status: "running", latestTurnId: s.queuedId });
    expect(resumed).toEqual([[s.threadId, s.queuedId]]);
  });

  it("settles a dead turn as before; a quota holding the thread keeps the queue behind it", async () => {
    const s = await setup();
    await holdProject(s.engine, s.projectId);
    const report = await recoverUnsettledTurns(s.engine);
    expect(report).toMatchObject({ turns: 1, promoted: 0, held: 1 });
    const model = s.engine.getModel();
    expect(model.turns[s.liveId]).toMatchObject({ status: "error", error: RESTART_ERROR });
    expect(model.turns[s.queuedId]?.status).toBe("queued");
  });

  it("promotes the queue behind a dead turn when nothing holds it", async () => {
    const s = await setup();
    const report = await recoverUnsettledTurns(s.engine);
    expect(report).toMatchObject({ turns: 1, promoted: 1, held: 0 });
    expect(s.engine.getModel().turns[s.queuedId]?.status).toBe("requested");
  });
});
