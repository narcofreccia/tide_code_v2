import type { Message } from "@tide/contracts";
import { describe, expect, it } from "vitest";
import { agentStatus, isQuiescent, lostInRound, threadQuiet, threadsWithBackgroundChildren } from "./background.ts";
import { backgroundFixture, type BackgroundFixture } from "./background.testutil.ts";
import { DelegateWaits, DelegationReactor, type CancelTimer } from "./delegation.ts";
import { recoverLostChildren, recoverUnsettledTurns } from "./recovery.ts";
import { openEventStore } from "./store.ts";

describe("threadQuiet", () => {
  it("a thread with no turns is quiet", async () => {
    const f = await backgroundFixture();
    expect(threadQuiet(f.model(), f.leadId)).toEqual({ quiescent: true, turnInFlight: false, background: [] });
    expect(isQuiescent(f.model(), "nope")).toBe(true);
  });

  it("a running turn is not quiet, and its own sub-agent is foreground", async () => {
    const f = await backgroundFixture();
    const turn = await f.turn(f.leadId);
    await f.child(f.leadId, turn, "arch");
    expect(threadQuiet(f.model(), f.leadId)).toMatchObject({ quiescent: false, turnInFlight: true, background: [] });
  });

  it("a settled turn with a sub-agent still working is not quiet until it reports and the harness turn settles", async () => {
    const f = await backgroundFixture();
    const turn = await f.turn(f.leadId);
    const child = await f.child(f.leadId, turn, "arch");
    await f.settle(turn);
    const quiet = threadQuiet(f.model(), f.leadId);
    expect(quiet.quiescent).toBe(false);
    expect(quiet.turnInFlight).toBe(false);
    expect(quiet.background.map((c) => c.name)).toEqual(["arch"]);
    const thread = f.model().threads[f.leadId];
    if (!thread) throw new Error("expected thread");
    expect(agentStatus(f.model(), thread)).toBe("working (1 background sub-agent)");
    expect(agentStatus(f.model(), thread, { names: true })).toBe("working (1 background sub-agent: arch)");

    // the report opens a harness turn: requested, then running, then the child lands in it
    const harness = await f.turn(f.leadId, { harness: 'sub-agent "arch" reported', start: false });
    expect(threadQuiet(f.model(), f.leadId)).toMatchObject({ quiescent: false, turnInFlight: true });
    await f.engine.dispatch({ type: "turn.start", turnId: harness, provider: "claude" });
    await f.report(child);
    expect(isQuiescent(f.model(), f.leadId)).toBe(false);
    await f.settle(harness);
    expect(isQuiescent(f.model(), f.leadId)).toBe(true);
  });

  it("a lost sub-agent (closed as error) ends the wait and counts as lost in the round", async () => {
    const f = await backgroundFixture();
    const turn = await f.turn(f.leadId);
    await f.child(f.leadId, turn, "a");
    await f.child(f.leadId, turn, "b");
    await f.settle(turn);
    const thread = f.model().threads[f.leadId];
    if (!thread) throw new Error("expected thread");
    expect(agentStatus(f.model(), thread)).toBe("working (2 background sub-agents)");
    expect(await f.lose(f.leadId)).toBe(2);
    expect(isQuiescent(f.model(), f.leadId)).toBe(true);
    expect(lostInRound(f.model(), f.leadId)).toBe(2);
    // a new round (a message sent to the thread) starts the count again
    const next = await f.turn(f.leadId);
    await f.settle(next);
    expect(lostInRound(f.model(), f.leadId)).toBe(0);
  });
});

interface Timers {
  schedule: (fn: () => void, ms: number) => CancelTimer;
  fire(): void;
}

function manualTimers(): Timers {
  const timers: { fn: () => void; cancelled: boolean }[] = [];
  return {
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

function reactorFor(f: BackgroundFixture, timers: Timers): DelegationReactor {
  const reactor = new DelegationReactor({ engine: f.engine, waits: new DelegateWaits(), schedule: timers.schedule, log: () => undefined });
  reactor.start();
  return reactor;
}

const wakeUps = (f: BackgroundFixture): Message[] =>
  Object.values(f.model().messages).filter((m) => m.threadId === f.leadId && m.notification?.source === "delegate");

/** A delegate whose turn settled with "waiting" while one sub-agent works in the background. */
async function backgrounded(f: BackgroundFixture): Promise<{ threadId: string; childId: string }> {
  const d = await f.delegate("Planner");
  const childId = await f.child(d.threadId, d.turnId, "architect");
  await f.reply(d.turnId, "Waiting for the architecture agent.");
  await f.settle(d.turnId);
  return { threadId: d.threadId, childId };
}

describe("DelegationReactor — background sub-agents", () => {
  it("wakes the parent once, after the harness turn their report starts, with the final reply", async () => {
    const f = await backgroundFixture();
    const timers = manualTimers();
    const reactor = reactorFor(f, timers);
    const { threadId, childId } = await backgrounded(f);
    timers.fire();
    await reactor.drain();
    expect(wakeUps(f)).toEqual([]);

    const harness = await f.turn(threadId, { harness: 'sub-agent "architect" reported' });
    await f.report(childId);
    await f.reply(harness, "Plan ready: three modules.");
    await f.settle(harness);
    timers.fire();
    await reactor.drain();
    const [wake, ...rest] = wakeUps(f);
    expect(rest).toEqual([]);
    expect(wake?.text).toContain(`Delegate "Planner" (claude) finished: completed. Last reply:\nPlan ready: three modules.`);
    expect(wake?.text).not.toContain("without a report");
    timers.fire();
    await reactor.drain();
    expect(wakeUps(f)).toHaveLength(1);
  });

  it("wakes the parent when the last sub-agent is lost, and says so", async () => {
    const f = await backgroundFixture();
    const timers = manualTimers();
    const reactor = reactorFor(f, timers);
    const { threadId } = await backgrounded(f);
    await f.lose(threadId);
    timers.fire();
    await reactor.drain();
    const wakes = wakeUps(f);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.text).toContain(
      `Delegate "Planner" (claude) finished: completed. 1 background sub-agent ended without a report. Last reply:\nWaiting for the architecture agent.`,
    );
  });

  it("holds a usage limit hit while sub-agents work until the delegate is quiet", async () => {
    const f = await backgroundFixture();
    const timers = manualTimers();
    const reactor = reactorFor(f, timers);
    const { threadId } = await backgrounded(f);
    await f.engine.dispatch({ type: "thread.limited", threadId });
    timers.fire();
    await reactor.drain();
    expect(wakeUps(f)).toEqual([]);
    await f.lose(threadId);
    timers.fire();
    await reactor.drain();
    const wakes = wakeUps(f);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.text).toContain(`Delegate "Planner" (claude) finished: hit its usage limit. 1 background sub-agent ended without a report.`);
  });

  it("after a crash: recovery closes the lost sub-agent, the parent is woken once, and never again on the next boot", async () => {
    const store = await openEventStore(":memory:");
    const f = await backgroundFixture({ store });
    const { threadId } = await backgrounded(f);

    // boot 1: the order createApp uses — read, recover, then start the reactor and resume
    const boot = async (): Promise<void> => {
      const g = await backgroundFixture({ store });
      const before = threadsWithBackgroundChildren(g.model());
      await recoverUnsettledTurns(g.engine);
      await recoverLostChildren(g.engine);
      const timers = manualTimers();
      const reactor = reactorFor(g, timers);
      reactor.resumeAfterRestart(before);
      timers.fire();
      await reactor.drain();
      reactor.stop();
    };
    await boot();
    const after1 = await backgroundFixture({ store });
    expect(after1.model().activities["child-architect"]).toMatchObject({ status: "error" });
    expect(wakeUps(after1).map((m) => m.text.split(".")[0])).toEqual([`Delegate "Planner" (claude) finished: completed`]);
    expect(wakeUps(after1)[0]?.text).toContain("1 background sub-agent ended without a report");
    expect(after1.model().threads[threadId]?.delegatedBy).toBe(after1.leadId);

    await boot();
    expect(wakeUps(await backgroundFixture({ store }))).toHaveLength(1);
  });
});
