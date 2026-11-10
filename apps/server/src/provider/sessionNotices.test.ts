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

// R19 L5: a resume the harness refused loudly becomes one marked error row and a plain turn error.
describe("resume the harness refused (R19 L5)", () => {
  const errorRows = (model: ReadModel, threadId: string) =>
    (model.threadTimeline[threadId] ?? []).flatMap((entry) => {
      const activity = entry.kind === "activity" ? model.activities[entry.id] : undefined;
      return activity?.kind === "error" ? [activity] : [];
    });

  it("a refusal carried by settled.error (Claude) lands as the marked row and a readable turn error", async () => {
    const h = await harness();
    await firstTurnThenDropSession(h);
    h.control.script(emit({ type: "settled", status: "error", error: "resume-refused: No conversation found with session ID: sess-1" }));
    const records: { event: DomainEvent }[] = [];
    const stop = h.engine.subscribe((record) => records.push(record));
    const turnId = pick((await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "second" })).events, "turn.requested").turn.id;
    await h.reactor.drain();
    stop();

    const text = "Claude Code could not reopen its session (No conversation found with session ID: sess-1)";
    const upserted = records.map((r) => r.event).find((e): e is EventOf<"activity.upserted"> => e.type === "activity.upserted");
    expect(upserted?.activity).toMatchObject({ turnId, kind: "error", text, payload: { code: "resume-refused", harness: "No conversation found with session ID: sess-1" } });
    const model = h.engine.getModel();
    expect(model.turns[turnId]).toMatchObject({ status: "error", error: text });
    expect(errorRows(model, h.threadId)).toHaveLength(1);
    // nothing retried, no session started on its own
    expect(h.control.opened).toHaveLength(2);
    expect(model.threads[h.threadId]?.sessionBoundaryTurnId).toBeUndefined();
  });

  it("a refusal thrown by openSession (Codex, OpenCode) lands the same way", async () => {
    const h = await harness();
    await firstTurnThenDropSession(h);
    h.control.resumeError = new Error("resume-refused: no rollout found for thread id sess-1");
    const turnId = pick((await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "second" })).events, "turn.requested").turn.id;
    await h.reactor.drain();
    const model = h.engine.getModel();
    const rows = errorRows(model, h.threadId);
    expect(rows).toEqual([expect.objectContaining({ turnId, text: "Claude Code could not reopen its session (no rollout found for thread id sess-1)", payload: { code: "resume-refused", harness: "no rollout found for thread id sess-1" } })]);
    expect(model.turns[turnId]?.error).toBe("Claude Code could not reopen its session (no rollout found for thread id sess-1)");

    // the user's fresh session opens without resume and works
    h.control.script(emit({ type: "session", nativeSessionId: "sess-2" }), emit({ type: "settled", status: "completed" }));
    const fresh = pick((await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "again", freshSession: true })).events, "turn.requested").turn.id;
    await h.reactor.drain();
    expect(h.control.opened.at(-1)?.resume).toBeUndefined();
    expect(h.engine.getModel().turns[fresh]?.status).toBe("completed");
  });

  it("any other error keeps its plain row and text", async () => {
    const h = await harness();
    await firstTurnThenDropSession(h);
    h.control.resumeError = new Error("codex app-server failed to start: ENOENT");
    const turnId = pick((await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "second" })).events, "turn.requested").turn.id;
    await h.reactor.drain();
    const rows = errorRows(h.engine.getModel(), h.threadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("codex app-server failed to start: ENOENT");
    expect(rows[0]?.payload).toBeUndefined();
    expect(h.engine.getModel().turns[turnId]?.error).toBe("codex app-server failed to start: ENOENT");
  });
});
