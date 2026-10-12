import { afterEach, describe, expect, it } from "vitest";
import type { Answer } from "./wire.ts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { SettingsStore } from "../settings.ts";
import { createDecisionClient, TransientDecisionError, type Transport } from "./client.ts";
import { ERROR_LOG_INTERVAL_MS, TICK_MS, TriageReactor } from "./reactor.ts";
import { ManualClock, seedThreads } from "./testing.ts";

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
      answers[name] = name.endsWith("__urgency") && type === "score" ? { type: "score", score: 3, confidence: 0.8, probabilities: {} } : { type: "noul", noul: name.endsWith("__needsUser") ? 0.9 : 0.2 };
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
  const client = createDecisionClient({ settings, env: {}, transport: (p, t) => current(p, t), sleep: async () => undefined });
  const reactor = new TriageReactor({ engine, client, schedule: clock.schedule, now: () => clock.now, log: (m) => logs.push(m) });
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

function clockStart(r: Rig): void {
  r.clock.now = 1_000_000;
}
