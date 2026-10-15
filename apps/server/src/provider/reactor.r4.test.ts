import { afterEach, describe, expect, it } from "vitest";
import type { DomainEvent, EventOf } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { ProviderReactor } from "./reactor.ts";
import { DriverRegistry } from "./registry.ts";
import { SessionDirectory } from "./sessions.ts";
import { awaitInterrupt, awaitSteer, createFakeDriver, emit, type FakeDriverControl } from "./testing/fakeDriver.ts";

interface Harness {
  engine: Engine;
  reactor: ProviderReactor;
  claude: FakeDriverControl;
  codex: FakeDriverControl;
  projectId: string;
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

function waitFor(engine: Engine, match: (event: DomainEvent) => boolean): Promise<DomainEvent> {
  return new Promise((resolve) => {
    const off = engine.subscribe((record) => {
      if (!match(record.event)) return;
      off();
      resolve(record.event);
    });
  });
}

/** Two harnesses so provider switches and forks can be exercised; `caps` applies to claude. */
async function harness(caps: { steer?: boolean; fork?: boolean; rollback?: boolean } = {}): Promise<Harness> {
  const store = new EventStore(await openDatabase(":memory:"));
  const engine = new Engine({ store });
  const claude = createFakeDriver("claude");
  const codex = createFakeDriver("codex");
  claude.control.setCaps(caps);
  const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
  registry.register(claude.driver);
  registry.register(codex.driver);
  const sessions = new SessionDirectory({ registry, autoReap: false, log: () => undefined, model: () => engine.getModel() });
  const reactor = new ProviderReactor({ engine, sessions, log: () => undefined });
  reactor.start();
  const events: DomainEvent[] = [];
  engine.subscribe((r) => void events.push(r.event));
  const project = first((await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events.map((r) => r.event), "project.created");
  const thread = first((await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events.map((r) => r.event), "thread.created");
  const h: Harness = {
    engine,
    reactor,
    claude: claude.control,
    codex: codex.control,
    projectId: project.project.id,
    threadId: thread.thread.id,
    events,
    close: () => {
      reactor.stop();
      store.close();
    },
  };
  opened.push(h);
  return h;
}

async function turn(h: Harness, threadId: string, text: string): Promise<string> {
  const requested = first((await h.engine.dispatch({ type: "turn.request", threadId, text })).events.map((r) => r.event), "turn.requested");
  await h.reactor.drain();
  return requested.turn.id;
}

describe("ProviderReactor: steer", () => {
  it("delivers the message into the running turn when the harness can steer", async () => {
    const h = await harness({ steer: true });
    h.claude.script(emit({ type: "assistant.delta", messageKey: "m", delta: "working" }), awaitSteer(), emit({ type: "settled", status: "completed" }));
    const streamed = waitFor(h.engine, (e) => e.type === "assistant.delta");
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "start" });
    await streamed;
    await h.engine.dispatch({ type: "turn.steer", threadId: h.threadId, text: "also check tests" });
    await h.reactor.drain();
    expect(h.claude.steers.map((s) => s.input.text)).toEqual(["also check tests"]);
    expect(h.events.some((e) => e.type === "turn.steer-fell-back")).toBe(false);
    expect(Object.values(h.engine.getModel().turns)).toHaveLength(1);
    expect(h.engine.getModel().threads[h.threadId]?.status).toBe("idle");
  });

  it("falls back to a queued turn that then runs, when the harness cannot steer", async () => {
    const h = await harness();
    h.claude.script(emit({ type: "assistant.delta", messageKey: "m", delta: "working" }), awaitInterrupt(), emit({ type: "settled", status: "completed" }));
    h.claude.script(emit({ type: "settled", status: "completed" }));
    const streamed = waitFor(h.engine, (e) => e.type === "assistant.delta");
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "start" });
    await streamed;
    const fellBack = waitFor(h.engine, (e) => e.type === "turn.steer-fell-back");
    await h.engine.dispatch({ type: "turn.steer", threadId: h.threadId, text: "and then this" });
    const event = (await fellBack) as EventOf<"turn.steer-fell-back">;
    expect(event.reason).toMatch(/cannot take a message/);
    expect(event.turn.status).toBe("queued");
    await h.engine.dispatch({ type: "turn.interrupt", threadId: h.threadId });
    await h.reactor.drain();
    expect(h.claude.sessionFor(h.threadId)?.inputs.map((i) => i.text)).toEqual(["start", "and then this"]);
    expect(h.engine.getModel().turns[event.turn.id]?.status).toBe("completed");
  });

  it("falls back when the harness refuses the steer", async () => {
    const h = await harness({ steer: true });
    h.claude.steerError = new Error("no turn");
    h.claude.script(emit({ type: "assistant.delta", messageKey: "m", delta: "x" }), awaitInterrupt(), emit({ type: "settled", status: "completed" }));
    h.claude.script(emit({ type: "settled", status: "completed" }));
    const streamed = waitFor(h.engine, (e) => e.type === "assistant.delta");
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "start" });
    await streamed;
    const fellBack = waitFor(h.engine, (e) => e.type === "turn.steer-fell-back");
    await h.engine.dispatch({ type: "turn.steer", threadId: h.threadId, text: "late" });
    expect(((await fellBack) as EventOf<"turn.steer-fell-back">).reason).toMatch(/refused the message: no turn/);
    await h.engine.dispatch({ type: "turn.interrupt", threadId: h.threadId });
    await h.reactor.drain();
  });
});

describe("ProviderReactor: handoff delivery", () => {
  it("injects the handoff ahead of the prompt on a provider switch", async () => {
    const h = await harness();
    h.claude.script(emit({ type: "session", nativeSessionId: "c-1" }), emit({ type: "assistant.delta", messageKey: "m", delta: "claude answer" }), emit({ type: "settled", status: "completed" }));
    await turn(h, h.threadId, "first question");
    await h.engine.dispatch({ type: "thread.update", threadId: h.threadId, provider: "codex" });
    h.codex.script(emit({ type: "settled", status: "completed" }));
    const turnId = await turn(h, h.threadId, "next");
    const handoff = first(h.events, "handoff.recorded").handoff;
    const text = h.codex.sessionFor(h.threadId)?.inputs[0]?.text ?? "";
    expect(text).toBe(`${handoff.text}\n\n---\n\nUser message:\nnext`);
    expect(h.engine.getModel().turns[turnId]).toMatchObject({ handoffId: handoff.id, handoffDelivery: "inline" });
  });

  it("forks the source's native session and rolls back the turns after the fork point", async () => {
    const h = await harness({ fork: true, rollback: true });
    h.claude.script(emit({ type: "session", nativeSessionId: "src-1" }), emit({ type: "assistant.delta", messageKey: "m", delta: "one" }), emit({ type: "settled", status: "completed" }));
    const t1 = await turn(h, h.threadId, "first");
    h.claude.script(emit({ type: "assistant.delta", messageKey: "m", delta: "two" }), emit({ type: "settled", status: "completed" }));
    await turn(h, h.threadId, "second");
    const created = first((await h.engine.dispatch({ type: "thread.fork", threadId: h.threadId, turnId: t1 })).events.map((r) => r.event), "thread.created");
    const forkId = created.thread.id;
    h.claude.script(emit({ type: "settled", status: "completed" }));
    const turnId = await turn(h, forkId, "go on");
    const options = h.claude.opened.find((o) => o.threadId === forkId);
    expect(options).toMatchObject({ forkFrom: "src-1" });
    expect(options?.resume).toBeUndefined();
    expect(h.claude.rollbacks).toEqual([{ threadId: forkId, turns: 1, nativeSessionId: "src-1~fork2" }]);
    expect(h.claude.sessionFor(forkId)?.inputs[0]?.text).toBe("go on");
    expect(h.engine.getModel().turns[turnId]?.handoffDelivery).toBe("native");
    expect(h.engine.getModel().threads[forkId]?.nativeSessionId).toBe("src-1~fork2");
  });

  it("delivers a fork inline when the harness cannot fork", async () => {
    const h = await harness();
    h.claude.script(emit({ type: "session", nativeSessionId: "src-1" }), emit({ type: "assistant.delta", messageKey: "m", delta: "one" }), emit({ type: "settled", status: "completed" }));
    const t1 = await turn(h, h.threadId, "first");
    const created = first((await h.engine.dispatch({ type: "thread.fork", threadId: h.threadId, turnId: t1 })).events.map((r) => r.event), "thread.created");
    h.claude.script(emit({ type: "settled", status: "completed" }));
    const turnId = await turn(h, created.thread.id, "go on");
    expect(h.claude.opened.find((o) => o.threadId === created.thread.id)?.forkFrom).toBeUndefined();
    expect(h.claude.sessionFor(created.thread.id)?.inputs[0]?.text).toMatch(/\n\n---\n\nUser message:\ngo on$/);
    expect(h.engine.getModel().turns[turnId]?.handoffDelivery).toBe("inline");
  });

  it("falls back to inline when the fork point needs a rollback the harness cannot do", async () => {
    const h = await harness({ fork: true });
    h.claude.script(emit({ type: "session", nativeSessionId: "src-1" }), emit({ type: "assistant.delta", messageKey: "m", delta: "one" }), emit({ type: "settled", status: "completed" }));
    const t1 = await turn(h, h.threadId, "first");
    h.claude.script(emit({ type: "assistant.delta", messageKey: "m", delta: "two" }), emit({ type: "settled", status: "completed" }));
    await turn(h, h.threadId, "second");
    const created = first((await h.engine.dispatch({ type: "thread.fork", threadId: h.threadId, turnId: t1 })).events.map((r) => r.event), "thread.created");
    h.claude.script(emit({ type: "settled", status: "completed" }));
    const turnId = await turn(h, created.thread.id, "go on");
    expect(h.claude.opened.find((o) => o.threadId === created.thread.id)?.forkFrom).toBeUndefined();
    expect(h.engine.getModel().turns[turnId]?.handoffDelivery).toBe("inline");
  });
});

describe("ProviderReactor: limits", () => {
  it("marks the thread limited when the harness reports an exhausted window", async () => {
    const h = await harness();
    h.claude.script(emit({ type: "usage", rateLimit: { status: "limited", resetsAt: 5_000, note: "5-hour limit reached", at: 1 } }), emit({ type: "settled", status: "error", error: "stopped" }));
    await turn(h, h.threadId, "go");
    expect(h.engine.getModel().threads[h.threadId]?.limited).toMatchObject({ resetsAt: 5_000, note: "5-hour limit reached", resume: "manual" });
    // recorded after the settle
    const types = h.events.map((e) => e.type);
    expect(types.indexOf("thread.limited")).toBeGreaterThan(types.indexOf("turn.settled"));
  });

  it("recognises a usage-limit error text", async () => {
    const h = await harness();
    h.claude.script(emit({ type: "settled", status: "error", error: "Claude AI usage limit reached|1760000000" }));
    await turn(h, h.threadId, "go");
    expect(h.engine.getModel().threads[h.threadId]?.limited).toMatchObject({ note: "Claude AI usage limit reached|1760000000" });
  });

  it("leaves ordinary errors alone", async () => {
    const h = await harness();
    h.claude.script(emit({ type: "settled", status: "error", error: "tool crashed" }));
    await turn(h, h.threadId, "go");
    expect(h.engine.getModel().threads[h.threadId]?.limited).toBeUndefined();
  });
});
