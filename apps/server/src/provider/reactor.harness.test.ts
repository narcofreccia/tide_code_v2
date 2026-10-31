import { afterEach, describe, expect, it } from "vitest";
import type { DomainEvent, EventOf, ReadModel } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { ProviderReactor } from "./reactor.ts";
import { DriverRegistry } from "./registry.ts";
import { SessionDirectory } from "./sessions.ts";
import { awaitApproval, awaitInterrupt, awaitSteer, awaitUserInput, createFakeDriver, emit, type FakeDriverControl, type FakeSession } from "./testing/fakeDriver.ts";

// R14: turns Claude Code runs by itself (a background sub-agent reported) become ordinary Tide turns.

interface Harness {
  engine: Engine;
  reactor: ProviderReactor;
  control: FakeDriverControl;
  threadId: string;
  events: DomainEvent[];
  logs: string[];
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

function all<T extends DomainEvent["type"]>(events: DomainEvent[], type: T): EventOf<T>[] {
  return events.filter((e): e is EventOf<T> => e.type === type);
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

const assistantTexts = (model: ReadModel, turnId: string): (string | undefined)[] =>
  Object.values(model.messages)
    .filter((m) => m.turnId === turnId && m.role === "assistant")
    .map((m) => m.text);

async function harness(caps: { steer?: boolean } = {}): Promise<Harness> {
  const store = new EventStore(await openDatabase(":memory:"));
  const engine = new Engine({ store });
  const { driver, control } = createFakeDriver("claude");
  control.setCaps({ ...caps, harnessTurns: true });
  const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
  registry.register(driver);
  const logs: string[] = [];
  const log = (msg: string): void => void logs.push(msg);
  let reactor: ProviderReactor | undefined;
  const sessions = new SessionDirectory({
    registry,
    autoReap: false,
    log,
    model: () => engine.getModel(),
    onHarnessTurn: (threadId, turn) => reactor?.attachHarnessTurn(threadId, turn),
  });
  reactor = new ProviderReactor({ engine, sessions, log });
  reactor.start();
  const events: DomainEvent[] = [];
  engine.subscribe((r) => void events.push(r.event));
  const project = first((await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events.map((r) => r.event), "project.created");
  const thread = first((await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events.map((r) => r.event), "thread.created");
  const h: Harness = {
    engine,
    reactor,
    control,
    threadId: thread.thread.id,
    events,
    logs,
    close: () => {
      reactor.stop();
      store.close();
    },
  };
  opened.push(h);
  return h;
}

/** Runs one ordinary user turn so the thread has a live session, and returns it. */
async function openSession(h: Harness): Promise<FakeSession> {
  h.control.script(emit({ type: "session", nativeSessionId: "sess-1" }), emit({ type: "settled", status: "completed" }));
  await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "start the audit in the background" });
  await h.reactor.drain();
  const session = h.control.sessionFor(h.threadId);
  if (!session) throw new Error("expected a session");
  return session;
}

describe("ProviderReactor: harness-initiated turns", () => {
  it("runs a harness turn as a Tide turn with a harness notification, without sending anything", async () => {
    const h = await harness();
    const session = await openSession(h);
    const reason = "sub-agent 'Audit feature gaps' reported";
    const { drained } = session.emitHarnessTurn(reason, [
      { type: "assistant.delta", messageKey: "m0", delta: "The audit " },
      { type: "assistant.delta", messageKey: "m0", delta: "found 3 gaps." },
      { type: "activity", activity: { kind: "tool", toolUseId: "t1", toolName: "Read", input: { path: "a.ts" }, status: "ok", output: "x" } },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 4 } },
      { type: "settled", status: "completed" },
    ]);
    await h.reactor.drain();
    await drained;

    const requested = all(h.events, "turn.requested")[1];
    expect(requested?.userMessage).toMatchObject({ text: reason, notification: { source: "harness", summary: reason } });
    const turnId = requested!.turn.id;
    const model = h.engine.getModel();
    expect(model.turns[turnId]).toMatchObject({ status: "completed", provider: "claude" });
    expect(assistantTexts(model, turnId)).toEqual(["The audit found 3 gaps."]);
    expect(Object.values(model.activities).filter((a) => a.turnId === turnId).map((a) => a.kind)).toEqual(["tool"]);
    expect(model.turns[turnId]?.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
    expect(all(h.events, "turn.settled").map((e) => e.turnId)).toContain(turnId);
    // the harness was already running: no prompt was built or sent
    expect(session.inputs.map((i) => i.text)).toEqual(["start the audit in the background"]);
    expect(model.threads[h.threadId]).toMatchObject({ status: "idle", latestTurnId: turnId });
  });

  it("a sub-agent launched in one turn and reporting in a harness turn settles on its original row and turn", async () => {
    const h = await harness();
    h.control.script(
      emit({ type: "session", nativeSessionId: "sess-1" }),
      emit({ type: "activity", activity: { kind: "tool", toolUseId: "agent-1", toolName: "Agent", input: {}, status: "ok" } }),
      emit({ type: "activity", activity: { kind: "child", childKey: "agent-1", name: "Audit feature gaps", status: "running" } }),
      emit({ type: "settled", status: "completed" }),
    );
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "audit in the background" });
    await h.reactor.drain();
    const session = h.control.sessionFor(h.threadId)!;
    const firstTurn = all(h.events, "turn.requested")[0]!.turn.id;
    const before = Object.values(h.engine.getModel().activities).filter((a) => a.kind === "child");
    expect(before).toHaveLength(1);

    const { drained } = session.emitHarnessTurn('sub-agent "Audit feature gaps" reported', [
      { type: "activity", activity: { kind: "tool", toolUseId: "sub-bash", toolName: "Bash", input: {}, status: "ok", parentToolUseId: "agent-1" } },
      { type: "activity", activity: { kind: "child", childKey: "agent-1", name: "Audit feature gaps", status: "done", summary: "3 gaps", report: "3 gaps found" } },
      { type: "assistant.delta", messageKey: "m0", delta: "The audit is in." },
      { type: "settled", status: "completed" },
    ]);
    await h.reactor.drain();
    await drained;

    const model = h.engine.getModel();
    const children = Object.values(model.activities).filter((a) => a.kind === "child");
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ id: before[0]!.id, turnId: firstTurn, status: "done", report: "3 gaps found" });
    // the sub-agent's own tool row joins the turn that launched it; Claude's text stays in the harness turn
    const subBash = Object.values(model.activities).find((a) => a.kind === "tool" && a.toolUseId === "sub-bash");
    expect(subBash?.turnId).toBe(firstTurn);
    const harnessTurn = all(h.events, "turn.requested")[1]!.turn.id;
    expect(assistantTexts(model, harnessTurn)).toEqual(["The audit is in."]);
  });

  it("a question asked inside a harness turn needs the user like in any turn, and the answer reaches the harness", async () => {
    const h = await harness();
    const session = await openSession(h);
    const asked = waitFor(h.engine, (e) => e.type === "activity.upserted");
    session.emitHarnessTurn("sub-agent reported", [
      { type: "activity", activity: { kind: "user-input", requestId: "q1", questions: [{ id: "a", text: "Fix all three?" }], status: "pending" } },
      awaitUserInput("q1"),
      { type: "assistant.delta", messageKey: "m0", delta: "on it" },
      { type: "settled", status: "completed" },
    ]);
    await asked;
    expect(h.engine.getModel().threads[h.threadId]).toMatchObject({ status: "running", attention: "question" });
    await h.engine.dispatch({ type: "user-input.respond", threadId: h.threadId, requestId: "q1", answers: { a: "yes" } });
    await h.reactor.drain();
    expect(h.control.userInputs).toEqual([{ requestId: "q1", answers: { a: "yes" } }]);
    const model = h.engine.getModel();
    expect(model.threads[h.threadId]?.attention).toBeUndefined();
    expect(model.turns[model.threads[h.threadId]!.latestTurnId!]?.status).toBe("completed");
  });

  it("a user turn typed during a harness turn runs after it, with its own turnId and no cross-talk", async () => {
    const h = await harness();
    const session = await openSession(h);
    const waiting = waitFor(h.engine, (e) => e.type === "activity.upserted");
    session.emitHarnessTurn("sub-agent reported", [
      { type: "assistant.delta", messageKey: "m0", delta: "harness says" },
      { type: "activity", activity: { kind: "approval", requestId: "r1", toolName: "Bash", input: { command: "ls" }, status: "pending" } },
      awaitApproval("r1"),
      { type: "settled", status: "completed" },
    ]);
    await waiting;
    h.control.script(emit({ type: "assistant.delta", messageKey: "m0", delta: "user reply" }), emit({ type: "settled", status: "completed" }));
    const user = first((await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "and also" })).events.map((r) => r.event), "turn.requested");
    expect(user.turn.status).toBe("queued");
    expect(session.inputs).toHaveLength(1);
    await h.engine.dispatch({ type: "approval.respond", threadId: h.threadId, requestId: "r1", decision: "accept" });
    await h.reactor.drain();

    const harnessTurn = all(h.events, "turn.requested")[1]!.turn.id;
    expect(harnessTurn).not.toBe(user.turn.id);
    const model = h.engine.getModel();
    expect(assistantTexts(model, harnessTurn)).toEqual(["harness says"]);
    expect(assistantTexts(model, user.turn.id)).toEqual(["user reply"]);
    expect(all(h.events, "turn.started").map((e) => e.turnId).slice(1)).toEqual([harnessTurn, user.turn.id]);
    expect(model.turns[harnessTurn]?.status).toBe("completed");
    expect(model.turns[user.turn.id]?.status).toBe("completed");
    expect(session.inputs.map((i) => i.text)).toEqual(["start the audit in the background", "and also"]);
  });

  it("interrupts a harness turn through the session", async () => {
    const h = await harness();
    const session = await openSession(h);
    const streamed = waitFor(h.engine, (e) => e.type === "assistant.delta");
    session.emitHarnessTurn("sub-agent reported", [{ type: "assistant.delta", messageKey: "m0", delta: "working" }, awaitInterrupt(), { type: "settled", status: "interrupted" }]);
    await streamed;
    await h.engine.dispatch({ type: "turn.interrupt", threadId: h.threadId });
    await h.reactor.drain();
    expect(h.control.interrupts).toEqual([h.threadId]);
    const model = h.engine.getModel();
    expect(model.turns[model.threads[h.threadId]!.latestTurnId!]?.status).toBe("interrupted");
  });

  it("steers reach a running harness turn", async () => {
    const h = await harness({ steer: true });
    const session = await openSession(h);
    const streamed = waitFor(h.engine, (e) => e.type === "assistant.delta");
    session.emitHarnessTurn("sub-agent reported", [{ type: "assistant.delta", messageKey: "m0", delta: "working" }, awaitSteer(), { type: "settled", status: "completed" }]);
    await streamed;
    await h.engine.dispatch({ type: "turn.steer", threadId: h.threadId, text: "skip the docs" });
    await h.reactor.drain();
    expect(h.control.steers.map((s) => s.input.text)).toEqual(["skip the docs"]);
    expect(all(h.events, "turn.steer-fell-back")).toHaveLength(0);
  });

  it("drains a harness turn whose thread is archived, so the driver releases it", async () => {
    const h = await harness();
    const session = await openSession(h);
    await h.engine.dispatch({ type: "thread.archive", threadId: h.threadId, keepWorktree: true });
    const { drained } = session.emitHarnessTurn("sub-agent reported", [{ type: "assistant.delta", messageKey: "m0", delta: "lost" }, { type: "settled", status: "completed" }]);
    await h.reactor.drain();
    await drained;
    expect(all(h.events, "turn.requested")).toHaveLength(1);
    expect(h.logs.some((l) => l.includes("harness turn refused"))).toBe(true);
  });

  it("drains a harness turn that was dequeued before it ran", async () => {
    const h = await harness();
    const session = await openSession(h);
    h.control.script(emit({ type: "assistant.delta", messageKey: "m0", delta: "busy" }), awaitInterrupt(), emit({ type: "settled", status: "completed" }));
    const streamed = waitFor(h.engine, (e) => e.type === "assistant.delta");
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "long task" });
    await streamed;
    const queued = waitFor(h.engine, (e) => e.type === "turn.requested");
    const { drained } = session.emitHarnessTurn("sub-agent reported", [{ type: "assistant.delta", messageKey: "m9", delta: "never shown" }, { type: "settled", status: "completed" }]);
    const harnessTurn = (await queued) as EventOf<"turn.requested">;
    expect(harnessTurn.turn.status).toBe("queued");
    await h.engine.dispatch({ type: "turn.dequeue", turnId: harnessTurn.turn.id });
    await drained;
    await h.engine.dispatch({ type: "turn.interrupt", threadId: h.threadId });
    await h.reactor.drain();
    const model = h.engine.getModel();
    expect(model.turns[harnessTurn.turn.id]).toBeUndefined();
    expect(Object.values(model.messages).some((m) => m.text === "never shown")).toBe(false);
  });
});
