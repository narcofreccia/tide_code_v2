import { afterEach, describe, expect, it } from "vitest";
import type { DomainEvent, EventOf, ImageInput } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { ProviderReactor } from "./reactor.ts";
import { DriverRegistry } from "./registry.ts";
import { SessionDirectory } from "./sessions.ts";
import { awaitInterrupt, createFakeDriver, emit, type FakeDriverControl } from "./testing/fakeDriver.ts";

// R20: windowed gauges, limits that keep the thread's queue, and `turn.released`.

interface Harness {
  engine: Engine;
  reactor: ProviderReactor;
  claude: FakeDriverControl;
  sessions: SessionDirectory;
  threadId: string;
  events: DomainEvent[];
  close(): void;
}

const opened: Harness[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.close();
});

function first<T extends DomainEvent["type"]>(events: DomainEvent[], type: T): EventOf<T> {
  const found = events.find((e): e is EventOf<T> => e.type === type);
  if (!found) throw new Error(`expected ${type}`);
  return found;
}

function waitFor(engine: Engine, match: (event: DomainEvent) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const off = engine.subscribe((record) => {
      if (!match(record.event)) return;
      off();
      resolve();
    });
  });
}

async function harness(): Promise<Harness> {
  const store = new EventStore(await openDatabase(":memory:"));
  const engine = new Engine({ store });
  const claude = createFakeDriver("claude");
  const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
  registry.register(claude.driver);
  const sessions = new SessionDirectory({ registry, autoReap: false, log: () => undefined, model: () => engine.getModel() });
  const reactor = new ProviderReactor({ engine, sessions, log: () => undefined });
  reactor.start();
  const events: DomainEvent[] = [];
  engine.subscribe((r) => void events.push(r.event));
  const project = first((await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events.map((r) => r.event), "project.created");
  const thread = first((await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events.map((r) => r.event), "thread.created");
  const h: Harness = { engine, reactor, claude: claude.control, sessions, threadId: thread.thread.id, events, close: () => (reactor.stop(), store.close()) };
  opened.push(h);
  return h;
}

const IMAGE: ImageInput = { mediaType: "image/png", data: "AAAA" };

/** A first turn that hits the session limit while a second one (with an image) waits queued behind it. */
async function limitedWithQueue(h: Harness): Promise<{ firstId: string; secondId: string }> {
  h.claude.script(
    emit({ type: "assistant.delta", messageKey: "m0", delta: "working" }),
    awaitInterrupt(),
    emit({ type: "usage", rateLimit: { status: "limited", window: "session", resetsAt: 5_000, note: "5-hour limit reached", at: 1 } }),
    emit({ type: "settled", status: "interrupted" }),
  );
  const streamed = waitFor(h.engine, (e) => e.type === "assistant.delta");
  const firstReq = first((await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "first" })).events.map((r) => r.event), "turn.requested");
  await streamed;
  const secondReq = first((await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "second", images: [IMAGE] })).events.map((r) => r.event), "turn.requested");
  expect(secondReq.turn.status).toBe("queued");
  await h.engine.dispatch({ type: "turn.interrupt", threadId: h.threadId });
  await h.reactor.drain();
  return { firstId: firstReq.turn.id, secondId: secondReq.turn.id };
}

describe("ProviderReactor: windowed gauges", () => {
  it("drops a gauge report identical to the stored one and stores a changed one", async () => {
    const h = await harness();
    const gauge = { status: "ok" as const, window: "session" as const, resetsAt: 9_000 };
    h.claude.script(
      emit({ type: "usage", rateLimit: { ...gauge, remainingPct: 80.2, at: 1 } }),
      emit({ type: "usage", rateLimit: { ...gauge, window: "weekly", remainingPct: 40, at: 1 } }),
      emit({ type: "usage", rateLimit: { ...gauge, remainingPct: 79.8, at: 2 } }),
      // tokens always go through, even with an unchanged gauge on them
      emit({ type: "usage", usage: { inputTokens: 5, outputTokens: 1 }, rateLimit: { ...gauge, remainingPct: 80, at: 3 } }),
      emit({ type: "usage", rateLimit: { ...gauge, remainingPct: 70, at: 4 } }),
      emit({ type: "settled", status: "completed" }),
    );
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "go" });
    await h.reactor.drain();
    const reports = h.events.filter((e): e is EventOf<"usage.reported"> => e.type === "usage.reported");
    expect(reports.map((r) => r.rateLimit?.at)).toEqual([1, 1, 3, 4]);
    expect(h.engine.getModel().limits?.["claude"]).toMatchObject({ session: { remainingPct: 70, at: 4 }, weekly: { remainingPct: 40 } });
  });
});

describe("ProviderReactor: limits keep the queue", () => {
  it("records the window that refused the turn", async () => {
    const h = await harness();
    h.claude.script(emit({ type: "usage", rateLimit: { status: "limited", window: "weekly", resetsAt: 5_000, at: 1 } }), emit({ type: "settled", status: "error", error: "stopped" }));
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "go" });
    await h.reactor.drain();
    expect(h.engine.getModel().threads[h.threadId]?.limited).toMatchObject({ window: "weekly", resetsAt: 5_000 });
  });

  it("a limit from the error text stays windowless and still holds the queue", async () => {
    const h = await harness();
    h.claude.script(emit({ type: "assistant.delta", messageKey: "m0", delta: "x" }), awaitInterrupt(), emit({ type: "settled", status: "error", error: "Claude AI usage limit reached|1760000000" }));
    const streamed = waitFor(h.engine, (e) => e.type === "assistant.delta");
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "first" });
    await streamed;
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "second" });
    await h.engine.dispatch({ type: "turn.interrupt", threadId: h.threadId });
    await h.reactor.drain();
    expect(first(h.events, "turn.settled").holdQueue).toBe(true);
    expect(h.engine.getModel().threads[h.threadId]?.limited?.window).toBeUndefined();
    expect(h.claude.sessionFor(h.threadId)?.inputs).toHaveLength(1);
  });

  it("a turn cut short by the limit settles with holdQueue: the queued turn stays queued", async () => {
    const h = await harness();
    const { firstId, secondId } = await limitedWithQueue(h);
    const settled = first(h.events, "turn.settled");
    expect(settled).toMatchObject({ turnId: firstId, holdQueue: true });
    const model = h.engine.getModel();
    expect(model.turns[secondId]?.status).toBe("queued");
    expect(model.threads[h.threadId]).toMatchObject({ status: "interrupted", limited: { window: "session" } });
    expect(h.claude.sessionFor(h.threadId)?.inputs.map((i) => i.text)).toEqual(["first"]);
    expect(h.events.filter((e) => e.type === "thread.limited")).toHaveLength(1);
  });

  it("turn.released starts the held turn once, with its text and images", async () => {
    const h = await harness();
    const { secondId } = await limitedWithQueue(h);
    h.claude.script(emit({ type: "assistant.delta", messageKey: "m1", delta: "two" }), emit({ type: "settled", status: "completed" }));
    // lifting the limit releases the oldest queued turn (decider: thread.resume -> turn.released)
    await h.engine.dispatch({ type: "thread.resume", threadId: h.threadId });
    await h.reactor.drain();
    expect(h.events.filter((e) => e.type === "turn.released")).toHaveLength(1);
    const inputs = h.claude.sessionFor(h.threadId)?.inputs ?? [];
    expect(inputs.map((i) => i.text)).toEqual(["first", "second"]);
    expect(inputs[1]?.images).toEqual([IMAGE]);
    expect(h.engine.getModel().turns[secondId]?.status).toBe("completed");
    expect(h.events.filter((e) => e.type === "turn.started" && e.turnId === secondId)).toHaveLength(1);
  });

  it("a reactor that never saw the held turn (restart) reads it back from the model", async () => {
    const h = await harness();
    const { secondId } = await limitedWithQueue(h);
    h.reactor.stop();
    const restarted = new ProviderReactor({ engine: h.engine, sessions: h.sessions, log: () => undefined, imagesFor: (turnId) => (turnId === secondId ? [IMAGE] : undefined) });
    restarted.start();
    h.claude.script(emit({ type: "settled", status: "completed" }));
    await h.engine.dispatch({ type: "thread.resume", threadId: h.threadId });
    await restarted.drain();
    restarted.stop();
    const inputs = h.claude.sessionFor(h.threadId)?.inputs ?? [];
    expect(inputs.map((i) => i.text)).toEqual(["first", "second"]);
    expect(inputs[1]?.images).toEqual([IMAGE]);
    expect(h.engine.getModel().turns[secondId]?.status).toBe("completed");
  });
});
