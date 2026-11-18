import { describe, expect, it } from "vitest";
import type { Message, RpcFrame } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { DelegateWaits, DelegationReactor, type CancelTimer } from "../orchestration/delegation.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { registerAgentThreadHandlers } from "./agentThreads.ts";
import { RpcRouter, type RpcConnection } from "./router.ts";

/** Manual one-shot timers: nothing fires until the test says so. */
function manualTimers(): { count: () => number; schedule: (fn: () => void, ms: number) => CancelTimer; fire: () => void } {
  const timers: { fn: () => void; cancelled: boolean }[] = [];
  return {
    count: () => timers.filter((t) => !t.cancelled).length,
    schedule: (fn) => {
      const t = { fn, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
    fire: () => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    },
  };
}

interface Setup {
  engine: Engine;
  reactor: DelegationReactor;
  batch: ReturnType<typeof manualTimers>;
  connection: RpcConnection;
  frames: RpcFrame[];
  parentId: string;
  childId: string;
  turnId: string;
  finish(reply: string): Promise<void>;
  wakeUps(): Message[];
}

/**
 * A parent with one running delegate, the delegation reactor, and the real `agent.thread.wait`
 * handler behind an agent connection that speaks for the parent.
 */
async function setup(): Promise<Setup> {
  const engine = new Engine({ store: new EventStore(await openDatabase(":memory:")), now: () => 1_000 });
  const project = (await engine.dispatch({ type: "project.create", title: "P", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project");
  const parent = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude", title: "Lead" })).events[0]?.event;
  if (parent?.type !== "thread.created") throw new Error("expected thread");
  const waits = new DelegateWaits();
  const batch = manualTimers();
  const reactor = new DelegationReactor({ engine, waits, schedule: batch.schedule, log: () => undefined });
  reactor.start();
  const router = new RpcRouter();
  // the wait's own timeout never fires in these tests
  registerAgentThreadHandlers(router, { engine, waits, schedule: manualTimers().schedule });
  const frames: RpcFrame[] = [];
  const connection = router.connection("agent-1", (f) => frames.push(f), { agentThreadId: parent.thread.id });

  const r = await engine.dispatch({ type: "thread.delegate", fromThreadId: parent.thread.id, provider: "codex", prompt: "do it", title: "Child" });
  const created = r.events.find((x) => x.event.type === "thread.created")?.event;
  const requested = r.events.find((x) => x.event.type === "turn.requested")?.event;
  if (created?.type !== "thread.created" || requested?.type !== "turn.requested") throw new Error("expected a delegate");
  await engine.dispatch({ type: "turn.start", turnId: requested.turn.id, provider: "codex" });
  const turnId = requested.turn.id;

  return {
    engine,
    reactor,
    batch,
    connection,
    frames,
    parentId: parent.thread.id,
    childId: created.thread.id,
    turnId,
    async finish(reply) {
      await engine.dispatch({ type: "assistant.append", turnId, messageId: "m1", delta: reply });
      await engine.dispatch({ type: "turn.settle", turnId, status: "completed" });
    },
    wakeUps: () => Object.values(engine.getModel().messages).filter((m) => m.threadId === parent.thread.id && m.notification?.source === "delegate"),
  };
}

/** Fires the batch window and lets the wake-up dispatch land. */
async function flush(s: Setup): Promise<void> {
  s.batch.fire();
  await s.reactor.drain();
}

describe("agent.thread.wait — the delegate's finish reaches the parent exactly once", () => {
  it("a wait that returns the child's result to a listening caller sends no wake-up", async () => {
    const s = await setup();
    const wait = s.connection.handleRequest("w1", "agent.thread.wait", { threadId: s.childId });
    await s.finish("done");
    await wait;
    expect(s.frames).toEqual([{ id: "w1", result: expect.objectContaining({ settled: true, timedOut: false, lastAssistantText: "done" }) }]);
    await flush(s);
    expect(s.batch.count()).toBe(0);
    expect(s.wakeUps()).toEqual([]);
  });

  it("a wait cancelled before the child finishes: the later finish wakes the parent once", async () => {
    const s = await setup();
    const wait = s.connection.handleRequest("w1", "agent.thread.wait", { threadId: s.childId });
    expect(s.connection.cancelCall("w1")).toBe(true);
    await wait;
    expect(s.frames).toEqual([]);
    await s.finish("done");
    await flush(s);
    const wakes = s.wakeUps();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.text).toContain(`Delegate "Child" (codex) finished: completed. Last reply:\ndone`);
  });

  it("the child finishes while the wait is registered but the caller cancels before the response: one wake-up", async () => {
    const s = await setup();
    const wait = s.connection.handleRequest("w1", "agent.thread.wait", { threadId: s.childId });
    // subscribed after the reactor and the wait: runs once both saw the settle, before the handler resumes
    const off = s.engine.subscribe((record) => {
      if (record.event.type === "turn.settled" && record.event.threadId === s.childId) s.connection.cancelCall("w1");
    });
    await s.finish("done");
    off();
    await wait;
    expect(s.frames).toEqual([]);
    await flush(s);
    expect(s.wakeUps()).toHaveLength(1);
  });

  it("the child finishes while the wait is registered but the socket closes before the response: one wake-up", async () => {
    const s = await setup();
    const wait = s.connection.handleRequest("w1", "agent.thread.wait", { threadId: s.childId });
    const off = s.engine.subscribe((record) => {
      if (record.event.type === "turn.settled" && record.event.threadId === s.childId) s.connection.close();
    });
    await s.finish("done");
    off();
    await wait;
    expect(s.frames).toEqual([]);
    await flush(s);
    expect(s.wakeUps()).toHaveLength(1);
  });

  it("the socket closes mid-wait and the child finishes later: one wake-up", async () => {
    const s = await setup();
    const wait = s.connection.handleRequest("w1", "agent.thread.wait", { threadId: s.childId });
    s.connection.close();
    await wait;
    await s.finish("done");
    await flush(s);
    expect(s.wakeUps()).toHaveLength(1);
    expect(s.frames).toEqual([]);
  });
});
