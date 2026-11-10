import { afterEach, describe, expect, it } from "vitest";
import type { DomainEvent, EventOf, ReadModel } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { ProviderReactor } from "./reactor.ts";
import { DriverRegistry } from "./registry.ts";
import { SessionDirectory } from "./sessions.ts";
import { createFakeDriver, emit, type FakeDriverControl } from "./testing/fakeDriver.ts";

// R18 D1: a resume the harness could not honour shows as a session boundary + one reason row.

interface Harness {
  engine: Engine;
  reactor: ProviderReactor;
  sessions: SessionDirectory;
  control: FakeDriverControl;
  threadId: string;
  close(): void;
}

const opened: Harness[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.close();
});

function pick<T extends DomainEvent["type"]>(events: { event: DomainEvent }[], type: T): EventOf<T> {
  const found = events.map((r) => r.event).find((e): e is EventOf<T> => e.type === type);
  if (!found) throw new Error(`expected ${type}`);
  return found;
}

async function harness(): Promise<Harness> {
  const store = new EventStore(await openDatabase(":memory:"));
  const engine = new Engine({ store });
  const { driver, control } = createFakeDriver("claude");
  const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
  registry.register(driver);
  const sessions = new SessionDirectory({ registry, autoReap: false, log: () => undefined, model: () => engine.getModel() });
  const reactor = new ProviderReactor({ engine, sessions, log: () => undefined });
  reactor.start();
  const project = pick((await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events, "project.created");
  const thread = pick((await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events, "thread.created");
  const h: Harness = {
    engine,
    reactor,
    sessions,
    control,
    threadId: thread.thread.id,
    close: () => {
      reactor.stop();
      store.close();
    },
  };
  opened.push(h);
  return h;
}

/** One turn on a session that already has a native id, then the live session goes (reaper / restart). */
async function firstTurnThenDropSession(h: Harness): Promise<void> {
  h.control.script(emit({ type: "session", nativeSessionId: "sess-1" }), emit({ type: "settled", status: "completed" }));
  await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "first" });
  await h.reactor.drain();
  await h.sessions.close(h.threadId);
}

const timelineKinds = (model: ReadModel, threadId: string): string[] => (model.threadTimeline[threadId] ?? []).map((entry) => entry.kind);
const infoTexts = (model: ReadModel, threadId: string): string[] =>
  (model.threadTimeline[threadId] ?? []).flatMap((entry) => {
    const activity = entry.kind === "activity" ? model.activities[entry.id] : undefined;
    return activity?.kind === "info" ? [activity.text] : [];
  });

describe("resume that did not hold (D1)", () => {
  it("a driver reporting resumeFailed gets a boundary on the reopening turn, one reason row, and the new id", async () => {
    const h = await harness();
    await firstTurnThenDropSession(h);
    h.control.resumeFails = "agent cannot load earlier sessions";
    h.control.script(emit({ type: "settled", status: "completed" }));
    const turnId = pick((await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "second" })).events, "turn.requested").turn.id;
    await h.reactor.drain();

    expect(h.control.opened[1]?.resume).toBe("sess-1");
    const model = h.engine.getModel();
    expect(model.threads[h.threadId]).toMatchObject({ sessionBoundaryTurnId: turnId, nativeSessionId: "sess-1~new2" });
    expect(model.turns[turnId]).toMatchObject({ status: "completed", freshSession: true });
    expect(timelineKinds(model, h.threadId)).toEqual(["message", "message", "boundary", "activity"]);
    expect(infoTexts(model, h.threadId)).toEqual(["Claude Code could not resume the previous session; it starts without the earlier context"]);

    // the next turn reuses the live session: no second boundary
    h.control.script(emit({ type: "settled", status: "completed" }));
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "third" });
    await h.reactor.drain();
    expect(timelineKinds(h.engine.getModel(), h.threadId).filter((kind) => kind === "boundary")).toHaveLength(1);
  });

  it("an instance whose caps declare resume: false is treated the same without the driver saying so", async () => {
    const h = await harness();
    h.control.setCaps({ resume: false });
    await h.sessions.caps("claude"); // cache the status, as the server does when listing providers
    await firstTurnThenDropSession(h);
    h.control.script(emit({ type: "settled", status: "completed" }));
    const turnId = pick((await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "second" })).events, "turn.requested").turn.id;
    await h.reactor.drain();
    expect(h.engine.getModel().threads[h.threadId]?.sessionBoundaryTurnId).toBe(turnId);
  });

  it("a resume that held records nothing", async () => {
    const h = await harness();
    await firstTurnThenDropSession(h);
    h.control.script(emit({ type: "settled", status: "completed" }));
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "second" });
    await h.reactor.drain();
    const model = h.engine.getModel();
    expect(model.threads[h.threadId]?.sessionBoundaryTurnId).toBeUndefined();
    expect(model.threads[h.threadId]?.nativeSessionId).toBe("sess-1");
    expect(infoTexts(model, h.threadId)).toEqual([]);
  });

  it("the first turn of a thread has nothing to resume, so nothing is lost", async () => {
    const h = await harness();
    h.control.resumeFails = "would fail";
    h.control.script(emit({ type: "session", nativeSessionId: "sess-1" }), emit({ type: "settled", status: "completed" }));
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "first" });
    await h.reactor.drain();
    expect(timelineKinds(h.engine.getModel(), h.threadId)).not.toContain("boundary");
  });
});
