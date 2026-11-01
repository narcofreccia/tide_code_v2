import type { RpcFrame } from "@tide/contracts";
import { describe, expect, it } from "vitest";
import { backgroundFixture, type BackgroundFixture } from "../orchestration/background.testutil.ts";
import { DriverRegistry } from "../provider/registry.ts";
import { registerAgentHandlers } from "./agent.ts";
import { registerAgentThreadHandlers, waitForThread, type CancelTimer } from "./agentThreads.ts";
import { runningByKind } from "./env.ts";
import { RpcRouter } from "./router.ts";

/** Calls a unary agent method as the lead thread, straight through the router. */
async function callAsLead<T>(f: BackgroundFixture, method: string, params: unknown): Promise<T> {
  const router = new RpcRouter();
  registerAgentHandlers(router, { engine: f.engine });
  registerAgentThreadHandlers(router, { engine: f.engine });
  const frames: RpcFrame[] = [];
  const conn = router.connection("c1", (frame) => frames.push(frame), { agentThreadId: f.leadId });
  await conn.handleRequest("1", method, params);
  const frame = frames[0] as { result?: T; error?: { message: string } } | undefined;
  if (frame?.result === undefined) throw new Error(`no result: ${JSON.stringify(frame)}`);
  return frame.result;
}

function manualTimer(): { schedule: (fn: () => void, ms: number) => CancelTimer; fire(): void } {
  let pending: (() => void) | undefined;
  return {
    schedule: (fn) => {
      pending = fn;
      return () => void (pending = undefined);
    },
    fire: () => pending?.(),
  };
}

/** A delegate whose turn settled while its "architect" sub-agent works on. */
async function backgrounded(f: BackgroundFixture) {
  const d = await f.delegate("Planner");
  const childId = await f.child(d.threadId, d.turnId, "architect");
  await f.reply(d.turnId, "Waiting for the architecture agent.");
  await f.settle(d.turnId);
  return { ...d, childId };
}

describe("agent.thread.wait through background sub-agents", () => {
  it("keeps waiting past the settle, through the harness turn, and returns the final reply", async () => {
    const f = await backgroundFixture();
    const d = await f.delegate("Planner");
    const childId = await f.child(d.threadId, d.turnId, "architect");
    const timer = manualTimer();
    let result: Awaited<ReturnType<typeof waitForThread>> | undefined;
    const waiting = waitForThread(f.engine, d.threadId, undefined, 60_000, timer.schedule).then((r) => (result = r));
    await f.reply(d.turnId, "Waiting for the architecture agent.");
    await f.settle(d.turnId);
    await f.engine.drain();
    expect(result).toBeUndefined();

    const harness = await f.turn(d.threadId, { harness: 'sub-agent "architect" reported' });
    await f.report(childId);
    await f.engine.drain();
    expect(result).toBeUndefined();
    await f.reply(harness, "Plan ready.");
    await f.settle(harness);
    await waiting;
    expect(result).toMatchObject({ settled: true, timedOut: false, status: "idle", lastAssistantText: "Plan ready." });
  });

  it("waits on an idle thread whose sub-agents still work; a lost one ends it", async () => {
    const f = await backgroundFixture();
    const d = await backgrounded(f);
    const timer = manualTimer();
    const waiting = waitForThread(f.engine, d.threadId, d.turnId, 60_000, timer.schedule);
    await f.lose(d.threadId);
    expect(await waiting).toMatchObject({ settled: true, timedOut: false, lastAssistantText: "Waiting for the architecture agent." });
  });

  it("on timeout reports the sub-agents still working, by name", async () => {
    const f = await backgroundFixture();
    const d = await backgrounded(f);
    await f.child(d.threadId, d.turnId, "tester");
    const timer = manualTimer();
    const waiting = waitForThread(f.engine, d.threadId, undefined, 60_000, timer.schedule);
    timer.fire();
    expect(await waiting).toMatchObject({ settled: false, timedOut: true, status: "working (2 background sub-agents: architect, tester)" });
    // nothing was cancelled
    expect(f.model().activities[d.childId]).toMatchObject({ status: "running" });
  });
});

describe("thread status while sub-agents work in the background", () => {
  it("tide_delegate_status, tide_thread_list and tide_thread_read report it as not settled", async () => {
    const f = await backgroundFixture();
    const d = await backgrounded(f);
    expect(await callAsLead(f, "agent.threadStatus", { threadId: d.threadId })).toMatchObject({
      status: "working (1 background sub-agent)",
      settled: false,
    });
    const list = await callAsLead<{ threads: { id: string; status: string }[] }>(f, "agent.thread.list", { includeDelegates: true });
    expect(list.threads.find((t) => t.id === d.threadId)?.status).toBe("working (1 background sub-agent)");
    const read = await callAsLead<{ thread: { status: string } }>(f, "agent.thread.read", { threadId: d.threadId });
    expect(read.thread.status).toBe("working (1 background sub-agent)");

    await f.lose(d.threadId);
    expect(await callAsLead(f, "agent.threadStatus", { threadId: d.threadId })).toMatchObject({ status: "idle", settled: true });
  });
});

describe("runningByKind", () => {
  it("counts a thread busy with background sub-agents only, once", async () => {
    const f = await backgroundFixture();
    const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
    expect(runningByKind(f.engine, registry).get("claude") ?? 0).toBe(0);
    const d = await backgrounded(f);
    await f.child(d.threadId, d.turnId, "tester");
    expect(runningByKind(f.engine, registry).get("claude")).toBe(1);
    // a running turn elsewhere adds one more
    const other = await f.thread("Other");
    await f.turn(other);
    expect(runningByKind(f.engine, registry).get("claude")).toBe(2);
    await f.lose(d.threadId);
    expect(runningByKind(f.engine, registry).get("claude")).toBe(1);
  });
});
