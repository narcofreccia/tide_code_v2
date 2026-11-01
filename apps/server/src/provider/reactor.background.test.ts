import { afterEach, describe, expect, it } from "vitest";
import type { ActivityOf, EventOf, DomainEvent } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { lostChildSummary, markChildrenLost } from "../orchestration/background.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { ProviderReactor } from "./reactor.ts";
import { DriverRegistry } from "./registry.ts";
import { SessionDirectory } from "./sessions.ts";
import { createFakeDriver, emit, type FakeDriverControl, type FakeSession } from "./testing/fakeDriver.ts";

// Background sub-agents end with their harness process: a session that closes takes them along.

interface Rig {
  engine: Engine;
  reactor: ProviderReactor;
  sessions: SessionDirectory;
  control: FakeDriverControl;
  clock: { t: number };
  threadId: string;
  close(): void;
}

const opened: Rig[] = [];
afterEach(() => {
  for (const r of opened.splice(0)) r.close();
});

function first<T extends DomainEvent["type"]>(events: DomainEvent[], type: T): EventOf<T> {
  const found = events.find((e): e is EventOf<T> => e.type === type);
  if (!found) throw new Error(`expected ${type}`);
  return found;
}

async function rig(): Promise<Rig> {
  const store = new EventStore(await openDatabase(":memory:"));
  const engine = new Engine({ store });
  const { driver, control } = createFakeDriver("claude");
  control.setCaps({ harnessTurns: true });
  const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
  registry.register(driver);
  const clock = { t: 0 };
  let reactor: ProviderReactor | undefined;
  const sessions = new SessionDirectory({
    registry,
    autoReap: false,
    idleMs: 1_000,
    now: () => clock.t,
    log: () => undefined,
    model: () => engine.getModel(),
    onHarnessTurn: (threadId, turn) => reactor?.attachHarnessTurn(threadId, turn),
    onIdleActivity: (threadId, event) => reactor?.ingestIdleActivity(threadId, event),
    onClosed: (threadId) => markChildrenLost(engine, threadId).then(() => undefined),
  });
  reactor = new ProviderReactor({ engine, sessions, log: () => undefined });
  reactor.start();
  const project = first((await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events.map((r) => r.event), "project.created");
  const thread = first((await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events.map((r) => r.event), "thread.created");
  const r: Rig = {
    engine,
    reactor,
    sessions,
    control,
    clock,
    threadId: thread.thread.id,
    close: () => {
      reactor.stop();
      store.close();
    },
  };
  opened.push(r);
  return r;
}

/** One turn that launches two sub-agents: `bg` keeps running in the background, `fg` finishes in the turn. */
async function launch(r: Rig): Promise<FakeSession> {
  r.control.script(
    emit({ type: "session", nativeSessionId: "sess-1" }),
    emit({ type: "activity", activity: { kind: "child", childKey: "bg", name: "Audit", status: "running" } }),
    emit({ type: "activity", activity: { kind: "child", childKey: "fg", name: "Lint", status: "running" } }),
    emit({ type: "activity", activity: { kind: "child", childKey: "fg", name: "Lint", status: "done", summary: "clean" } }),
    emit({ type: "settled", status: "completed" }),
  );
  await r.engine.dispatch({ type: "turn.request", threadId: r.threadId, text: "audit in the background" });
  await r.reactor.drain();
  const session = r.control.sessionFor(r.threadId);
  if (!session) throw new Error("expected a session");
  return session;
}

const children = (r: Rig): Record<string, ActivityOf<"child">> =>
  Object.fromEntries(
    Object.values(r.engine.getModel().activities)
      .filter((a): a is ActivityOf<"child"> => a.kind === "child")
      .map((a) => [a.childKey, a]),
  );

describe("ProviderReactor: background sub-agents and the session lifecycle", () => {
  it("a live session's background child is untouched, and the reaper keeps the session", async () => {
    const r = await rig();
    const session = await launch(r);
    session.backgroundWork = true;
    expect(r.engine.getModel().threads[r.threadId]?.status).toBe("idle");
    r.clock.t = 60_000;
    expect(await r.sessions.reapIdle()).toEqual([]);
    expect(children(r)["bg"]?.status).toBe("running");
  });

  it("closing the session closes the running background child as error with a summary; the finished one stays done", async () => {
    const r = await rig();
    await launch(r);
    await r.sessions.close(r.threadId);
    await r.reactor.drain();
    const rows = children(r);
    expect(rows["bg"]).toMatchObject({ status: "error", summary: lostChildSummary("Claude Code") });
    expect(rows["fg"]).toMatchObject({ status: "done", summary: "clean" });
  });

  it("the reaper closing a session whose agents went quiet for good resolves them too", async () => {
    const r = await rig();
    await launch(r); // the fake session reports no background work
    r.clock.t = 60_000;
    expect(await r.sessions.reapIdle()).toEqual([r.threadId]);
    expect(children(r)["bg"]?.status).toBe("error");
  });

  it("a driver that reports its own lost child lands it on the original row", async () => {
    const r = await rig();
    const session = await launch(r);
    const before = children(r)["bg"]!;
    session.emitIdleActivity({ type: "activity", activity: { kind: "child", childKey: "bg", name: "Audit", status: "error", summary: "No report: the Claude Code session ended before this sub-agent finished" } });
    await r.reactor.drain();
    const after = children(r)["bg"]!;
    expect(after.id).toBe(before.id);
    expect(after.turnId).toBe(before.turnId);
    expect(after.status).toBe("error");
  });
});
