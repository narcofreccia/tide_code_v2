import { afterEach, describe, expect, it } from "vitest";
import type { DomainEvent, EventOf } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { ProviderReactor } from "../provider/reactor.ts";
import { DriverRegistry } from "../provider/registry.ts";
import { SessionDirectory } from "../provider/sessions.ts";
import { createFakeDriver, effect, emit } from "../provider/testing/fakeDriver.ts";
import { QuotaWorker } from "./worker.ts";

// R20 end to end, with the real engine, reactor and quota worker: the turn that takes a project
// over its cap settles with the queue held, because the reactor lets the worker measure first.

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
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

async function setup(withHook: boolean) {
  const store = new EventStore(await openDatabase(":memory:"));
  const engine = new Engine({ store });
  const claude = createFakeDriver("claude");
  const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
  registry.register(claude.driver);
  const sessions = new SessionDirectory({ registry, autoReap: false, log: () => undefined, model: () => engine.getModel() });
  // a timer that never fires: passes come from events and from the reactor's hook only
  const quotas = new QuotaWorker({ engine, schedule: () => () => undefined });
  const reactor = new ProviderReactor({ engine, sessions, log: () => undefined, ...(withHook ? { beforeSettle: () => quotas.measureNow() } : {}) });
  reactor.start();
  quotas.start();
  closers.push(() => (quotas.stop(), reactor.stop(), store.close()));
  const events: DomainEvent[] = [];
  engine.subscribe((r) => void events.push(r.event));
  const dispatched = async (command: Parameters<Engine["dispatch"]>[0]) => (await engine.dispatch(command)).events.map((r) => r.event);
  const projectId = first(await dispatched({ type: "project.create", title: "Side", rootPath: "/repo" }), "project.created").project.id;
  const threadId = first(await dispatched({ type: "thread.create", projectId, provider: "claude" }), "thread.created").thread.id;
  await engine.dispatch({ type: "quota.set", scope: "project", id: projectId, quota: { usdPerWeek: 1, onExceed: "hold" } });
  await quotas.drain();
  return { engine, reactor, quotas, claude: claude.control, events, dispatched, projectId, threadId };
}

describe("a quota reached during a turn", () => {
  it("holds the queued turn at the settle, refuses a new send, and runs the queue after a lift", async () => {
    const h = await setup(true);
    let finish = (): void => undefined;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    h.claude.script(
      emit({ type: "assistant.delta", messageKey: "m0", delta: "working" }),
      effect(() => gate),
      emit({ type: "usage", usage: { inputTokens: 10, outputTokens: 5, costUsd: 2 } }),
      emit({ type: "settled", status: "completed" }),
    );
    const streamed = waitFor(h.engine, (e) => e.type === "assistant.delta");
    const firstTurn = first(await h.dispatched({ type: "turn.request", threadId: h.threadId, text: "first" }), "turn.requested").turn;
    await streamed;
    const second = first(await h.dispatched({ type: "turn.request", threadId: h.threadId, text: "second" }), "turn.requested").turn;
    expect(second.status).toBe("queued");

    finish();
    await h.reactor.drain();
    const settled = h.events.filter((e): e is EventOf<"turn.settled"> => e.type === "turn.settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ turnId: firstTurn.id, status: "completed", holdQueue: true });
    // the measurement landed before the settle
    const order = h.events.map((e) => e.type);
    expect(order.indexOf("quota.metered")).toBeGreaterThan(-1);
    expect(order.lastIndexOf("quota.metered")).toBeLessThan(order.indexOf("turn.settled"));
    const model = h.engine.getModel();
    expect(model.projects[h.projectId]?.quotaState).toMatchObject({ status: "exceeded", basis: "usd", over: ["*"] });
    expect(model.threads[h.threadId]?.status).toBe("idle");
    expect(model.turns[second.id]?.status).toBe("queued");

    await expect(h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "third" })).rejects.toMatchObject({ code: "quota-exceeded" });

    h.claude.script(emit({ type: "assistant.delta", messageKey: "m1", delta: "second done" }), emit({ type: "settled", status: "completed" }));
    const lifted = await h.dispatched({ type: "quota.lift", scope: "project", id: h.projectId });
    expect(first(lifted, "turn.released")).toMatchObject({ threadId: h.threadId, turnId: second.id });
    await h.reactor.drain();
    expect(h.engine.getModel().turns[second.id]?.status).toBe("completed");
    expect(h.claude.sessions.at(-1)).toBeDefined();
  });

  it("a turn that stays under the cap settles without a hold and the queue runs on", async () => {
    const h = await setup(true);
    let finish = (): void => undefined;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    h.claude.script(
      emit({ type: "assistant.delta", messageKey: "m0", delta: "working" }),
      effect(() => gate),
      emit({ type: "usage", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.2 } }),
      emit({ type: "settled", status: "completed" }),
    );
    const streamed = waitFor(h.engine, (e) => e.type === "assistant.delta");
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "first" });
    await streamed;
    const second = first(await h.dispatched({ type: "turn.request", threadId: h.threadId, text: "second" }), "turn.requested").turn;
    h.claude.script(emit({ type: "settled", status: "completed" }));
    finish();
    await h.reactor.drain();
    const settled = h.events.filter((e): e is EventOf<"turn.settled"> => e.type === "turn.settled");
    expect(settled[0]?.holdQueue).toBeUndefined();
    expect(h.engine.getModel().turns[second.id]?.status).toBe("completed");
    expect(h.engine.getModel().projects[h.projectId]?.quotaState).toMatchObject({ status: "ok" });
  });
});
