import { afterEach, describe, expect, it } from "vitest";
import type { Answer } from "./wire.ts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { SettingsStore } from "../settings.ts";
import { TransientDecisionError, type Transport } from "./client.ts";
import { ERROR_LOG_INTERVAL_MS, TICK_MS, TriageReactor } from "./reactor.ts";
import { createJudgeService } from "./service.ts";
import { fakeJudge, ManualClock, seedThreads } from "./testing.ts";
import type { DriverRegistry } from "../provider/registry.ts";

interface Rig {
  engine: Engine;
  reactor: TriageReactor;
  clock: ManualClock;
  settings: SettingsStore;
  payloads: { state: Record<string, unknown>; questions: Record<string, unknown> }[];
  logs: string[];
  setTransport(t: Transport): void;
}

const stores: EventStore[] = [];
const reactors: TriageReactor[] = [];
afterEach(() => {
  for (const r of reactors.splice(0)) r.stop();
  for (const s of stores.splice(0)) s.close();
});

/** Answers every question: needsUser 0.9, stuck 0.2, urgency level 3 (-> 0.75). */
function answering(payloads: Rig["payloads"]): Transport {
  return async (payload) => {
    const p = payload as Rig["payloads"][number];
    payloads.push(p);
    const answers: Record<string, Answer | object> = {};
    for (const [name, q] of Object.entries(p.questions)) {
      const type = (q as { type: string }).type;
      const instructions = (q as { instructions: string }).instructions;
      answers[name] = type === "score" ? { type: "score", score: 3, confidence: 0.8, probabilities: {} } : { type: "noul", noul: instructions.includes("waiting on the user") ? 0.9 : 0.2 };
    }
    return { model: "jev-1.13.0", usage: { input_tokens: 500, output_tokens: 9 }, answers };
  };
}

async function rig(enabled = true): Promise<Rig> {
  const store = new EventStore(await openDatabase(":memory:"));
  stores.push(store);
  const engine = new Engine({ store });
  const clock = new ManualClock();
  const settings = new SettingsStore();
  if (enabled) settings.set({ decisions: { enabled: true, apiKey: "k" } });
  const payloads: Rig["payloads"] = [];
  const logs: string[] = [];
  let current: Transport = answering(payloads);
  const registry = { has: () => false } as unknown as DriverRegistry;
  const { judge } = createJudgeService({ settings, registry, store, env: {}, dataDir: ":memory:", sleep: async () => undefined, transport: (p, t) => current(p, t) });
  const reactor = new TriageReactor({ engine, judge, schedule: clock.schedule, now: () => clock.now, log: (m) => logs.push(m) });
  reactor.start();
  reactors.push(reactor);
  return { engine, reactor, clock, settings, payloads, logs, setTransport: (t) => (current = t) };
}

describe("TriageReactor", () => {
  it("sends one batched request per project per burst and lands triage on the threads", async () => {
    const r = await rig();
    clockStart(r);
    const { threadIds, turnIds } = await seedThreads(r.engine, 2);
    // two settles inside the debounce window
    await r.engine.dispatch({ type: "turn.settle", turnId: turnIds[0] as string, status: "completed" });
    r.clock.advance(1000);
    await r.engine.dispatch({ type: "turn.settle", turnId: turnIds[1] as string, status: "completed" });
    expect(r.payloads).toHaveLength(0);
    r.clock.advance(2000);
    await r.reactor.drain();
    expect(r.payloads).toHaveLength(1);
    expect(Object.keys(r.payloads[0]?.state ?? {})).toHaveLength(2);
    const model = r.engine.getModel();
    for (const id of threadIds) expect(model.threads[id]?.triage).toEqual({ needsUser: 0.9, stuck: 0.2, urgency: 0.75, at: r.clock.now });
  });

  it("triggers on a pending approval and a proposed plan", async () => {
    const r = await rig();
    const { threadIds, turnIds } = await seedThreads(r.engine, 1);
    await r.engine.dispatch({
      type: "activity.upsert",
      activity: { id: "a1", threadId: threadIds[0] as string, turnId: turnIds[0] as string, createdAt: 1, updatedAt: 1, kind: "approval", requestId: "q", toolName: "Bash", input: {}, status: "pending" },
    });
    r.clock.advance(2000);
    await r.reactor.drain();
    expect(r.payloads).toHaveLength(1);
    expect(JSON.stringify(r.payloads[0]?.state)).toContain("PENDING APPROVAL");
    await r.engine.dispatch({ type: "plan.propose", turnId: turnIds[0] as string, markdown: "do it" });
    r.clock.advance(2000);
    await r.reactor.drain();
    expect(r.payloads).toHaveLength(2);
    expect(JSON.stringify(r.payloads[1]?.state)).toContain('"planProposed":true');
  });

  it("makes zero requests when disabled or keyless", async () => {
    const r = await rig(false);
    const { turnIds } = await seedThreads(r.engine, 1);
    await r.engine.dispatch({ type: "turn.settle", turnId: turnIds[0] as string, status: "completed" });
    expect(r.clock.pending).toBe(1); // only the periodic tick, no debounce timer
    r.clock.advance(TICK_MS);
    await r.reactor.drain();
    expect(r.payloads).toHaveLength(0);
    expect(r.logs).toEqual([]);
    // flag on but no key: still nothing
    r.settings.set({ decisions: { enabled: true } });
    await r.engine.dispatch({ type: "turn.request", threadId: Object.keys(r.engine.getModel().threads)[0] as string, text: "again" });
    expect(r.payloads).toHaveLength(0);
  });

  it("a transport failure does not break the reactor and is logged at most once per 5 min", async () => {
    const r = await rig();
    r.setTransport(async () => Promise.reject(new TransientDecisionError("HTTP 503", 503)));
    const { threadIds, turnIds } = await seedThreads(r.engine, 1);
    await r.engine.dispatch({ type: "turn.settle", turnId: turnIds[0] as string, status: "completed" });
    r.clock.advance(2000);
    await r.reactor.drain();
    expect(r.logs).toHaveLength(1);
    expect(r.engine.getModel().threads[threadIds[0] as string]?.triage).toBeUndefined();
    // second failure inside the window: not logged again
    await r.engine.dispatch({ type: "turn.request", threadId: threadIds[0] as string, text: "more" });
    await r.engine.dispatch({ type: "turn.start", turnId: Object.keys(r.engine.getModel().turns).at(-1) as string, provider: "claude" });
    await r.engine.dispatch({ type: "turn.settle", turnId: Object.keys(r.engine.getModel().turns).at(-1) as string, status: "completed" });
    r.clock.advance(2000);
    await r.reactor.drain();
    expect(r.logs).toHaveLength(1);
    // recovered transport works again later
    r.setTransport(answering(r.payloads));
    r.clock.advance(ERROR_LOG_INTERVAL_MS);
    await r.engine.dispatch({ type: "turn.request", threadId: threadIds[0] as string, text: "third" });
    const last = Object.keys(r.engine.getModel().turns).at(-1) as string;
    await r.engine.dispatch({ type: "turn.start", turnId: last, provider: "claude" });
    await r.engine.dispatch({ type: "turn.settle", turnId: last, status: "completed" });
    r.clock.advance(2000);
    await r.reactor.drain();
    expect(r.engine.getModel().threads[threadIds[0] as string]?.triage?.needsUser).toBe(0.9);
  });

  it("the 10-minute sweep asks about running threads that went silent", async () => {
    const r = await rig();
    const { threadIds } = await seedThreads(r.engine, 1); // turn started, never settled: running
    r.clock.now = Date.now() + 11 * 60_000;
    r.clock.advance(TICK_MS); // tick fires, schedules the debounce
    r.clock.advance(2000);
    await r.reactor.drain();
    expect(r.payloads).toHaveLength(1);
    expect(r.engine.getModel().threads[threadIds[0] as string]?.triage).toBeDefined();
  });

  it("stop() cancels timers and listening", async () => {
    const r = await rig();
    const { turnIds } = await seedThreads(r.engine, 1);
    await r.engine.dispatch({ type: "turn.settle", turnId: turnIds[0] as string, status: "completed" });
    r.reactor.stop();
    expect(r.clock.pending).toBe(0);
    r.clock.advance(TICK_MS);
    await r.reactor.drain();
    expect(r.payloads).toHaveLength(0);
  });
});

describe("TriageReactor with a fake judge", () => {
  it("asks one per-item question on site stuck and maps verdicts; a thread with a failed answer is skipped", async () => {
    const store = new EventStore(await openDatabase(":memory:"));
    stores.push(store);
    const engine = new Engine({ store });
    const clock = new ManualClock();
    const seeded = await seedThreads(engine, 2);
    const id = `triage:${seeded.projectId}`;
    const judge = fakeJudge({
      [`${id}:t0:needsUser`]: { score: 0.7 },
      [`${id}:t0:stuck`]: { score: 1, label: "true", source: "fallback" },
      [`${id}:t0:urgency`]: { score: 0.5 },
      [`${id}:t1:needsUser`]: { score: 0.1 },
      // t1 stuck: unscripted -> none (its call failed); t1 is not triaged
      [`${id}:t1:urgency`]: { score: 0.25 },
    });
    const reactor = new TriageReactor({ engine, judge, schedule: clock.schedule, now: () => clock.now, log: () => undefined });
    reactor.start();
    reactors.push(reactor);
    await engine.dispatch({ type: "turn.settle", turnId: seeded.turnIds[0] as string, status: "completed" });
    clock.advance(2000);
    await reactor.drain();
    expect(judge.questions).toHaveLength(1);
    const q = judge.questions[0];
    expect(q).toMatchObject({ kind: "per-item", site: "stuck", id });
    expect(q?.kind === "per-item" ? Object.keys(q.questions ?? {}) : []).toEqual(["needsUser", "stuck", "urgency"]);
    expect(q?.kind === "per-item" ? q.questions?.["needsUser"]?.threshold : undefined).toBe(0);
    expect(q?.kind === "per-item" ? q.questions?.["stuck"]?.threshold : 0).toBeUndefined();
    const model = engine.getModel();
    const triaged = seeded.threadIds.map((t) => model.threads[t]?.triage).filter((t) => t !== undefined);
    expect(triaged).toEqual([{ needsUser: 0.7, stuck: 1, urgency: 0.5, at: 2000 }]);
  });
});

describe("TriageReactor and background sub-agents", () => {
  it("treats a settled turn with running background agents as working; only their long silence re-asks", async () => {
    const store = new EventStore(await openDatabase(":memory:"));
    stores.push(store);
    const engine = new Engine({ store });
    const clock = new ManualClock();
    const judge = fakeJudge({});
    const reactor = new TriageReactor({ engine, judge, schedule: clock.schedule, now: () => clock.now, log: () => undefined });
    reactor.start(); // sweeps at 10, 20, … min
    reactors.push(reactor);
    const { threadIds, turnIds } = await seedThreads(engine, 1);
    const threadId = threadIds[0] as string;
    const turnId = turnIds[0] as string;
    const base = { threadId, turnId, createdAt: 0 };
    await engine.dispatch({ type: "activity.upsert", activity: { ...base, id: "bg", updatedAt: 0, kind: "child", childKey: "bg", name: "Audit", status: "running" } });
    await engine.dispatch({ type: "turn.settle", turnId, status: "completed" });
    clock.advance(2000);
    await reactor.drain();
    expect(judge.questions).toHaveLength(1);
    const q = judge.questions[0];
    const state = q?.kind === "per-item" ? q.items[0]?.state : undefined;
    expect(state).toMatchObject({ status: "working (background sub-agents)", backgroundAgents: ["Audit"] });

    // the agent keeps working: its tool call 10 s before the sweep keeps the thread off it
    await engine.dispatch({ type: "activity.upsert", activity: { ...base, id: "tool", updatedAt: 590_000, kind: "tool", toolUseId: "t1", toolName: "Bash", input: {}, status: "running", parentToolUseId: "bg" } });
    clock.advance(598_000); // the 10-min sweep
    clock.advance(2000);
    await reactor.drain();
    expect(judge.questions).toHaveLength(1);

    // silent for 10 more minutes: a stuck candidate
    clock.advance(598_000);
    clock.advance(2000);
    await reactor.drain();
    expect(judge.questions).toHaveLength(2);
  });
});

function clockStart(r: Rig): void {
  r.clock.now = 1_000_000;
}
