import { afterEach, describe, expect, it } from "vitest";
import type { DomainEvent, EventOf, ReadModel } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { INTERRUPT_TIMEOUT_ERROR, ProviderReactor, type CancelTimer } from "./reactor.ts";
import { DriverRegistry } from "./registry.ts";
import { SessionDirectory } from "./sessions.ts";
import { awaitApproval, awaitInterrupt, createFakeDriver, emit, throwStep, type FakeDriverControl } from "./testing/fakeDriver.ts";

interface Harness {
  engine: Engine;
  reactor: ProviderReactor;
  sessions: SessionDirectory;
  control: FakeDriverControl;
  projectId: string;
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

/** Resolves on the first event matching the predicate; register it before dispatching. */
function waitFor(engine: Engine, match: (event: DomainEvent) => boolean): Promise<DomainEvent> {
  return new Promise((resolve) => {
    let off: (() => void) | undefined;
    off = engine.subscribe((record) => {
      if (!match(record.event)) return;
      off?.();
      resolve(record.event);
    });
  });
}

/** Timers the test fires by hand, so the interrupt watchdog is exercised without a sleep. */
class ManualClock {
  now = 0;
  #pending: { fn: () => void; at: number }[] = [];

  schedule = (fn: () => void, ms: number): CancelTimer => {
    const entry = { fn, at: this.now + ms };
    this.#pending.push(entry);
    return () => {
      const i = this.#pending.indexOf(entry);
      if (i >= 0) this.#pending.splice(i, 1);
    };
  };

  get pending(): number {
    return this.#pending.length;
  }

  /** Moves the clock forward and runs everything that came due. */
  advance(ms: number): void {
    this.now += ms;
    const due = this.#pending.filter((e) => e.at <= this.now);
    this.#pending = this.#pending.filter((e) => e.at > this.now);
    for (const e of due) e.fn();
  }
}

interface HarnessOptions {
  schedule?: (fn: () => void, ms: number) => CancelTimer;
  interruptTimeoutMs?: number;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const store = new EventStore(await openDatabase(":memory:"));
  const engine = new Engine({ store });
  const { driver, control } = createFakeDriver("claude");
  const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
  registry.register(driver);
  const sessions = new SessionDirectory({ registry, autoReap: false, log: () => undefined });
  const reactor = new ProviderReactor({
    engine,
    sessions,
    log: () => undefined,
    ...(options.schedule !== undefined ? { schedule: options.schedule } : {}),
    ...(options.interruptTimeoutMs !== undefined ? { interruptTimeoutMs: options.interruptTimeoutMs } : {}),
  });
  reactor.start();

  const project = pick((await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events, "project.created");
  const thread = pick(
    (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events,
    "thread.created",
  );

  const h: Harness = {
    engine,
    reactor,
    sessions,
    control,
    projectId: project.project.id,
    threadId: thread.thread.id,
    close: () => {
      reactor.stop();
      store.close();
    },
  };
  opened.push(h);
  return h;
}

const activitiesOf = (model: ReadModel, threadId: string) =>
  (model.threadTimeline[threadId] ?? []).filter((e) => e.kind === "activity").map((e) => model.activities[e.id]);

describe("ProviderReactor: a full turn", () => {
  it("starts the turn, assembles deltas, upserts the tool row and settles", async () => {
    const h = await harness();
    h.control.script(
      emit({ type: "session", nativeSessionId: "sess-1", model: "fake-model" }),
      emit({ type: "assistant.delta", messageKey: "m0", delta: "Hel" }),
      emit({ type: "assistant.delta", messageKey: "m0", delta: "lo" }),
      emit({ type: "activity", activity: { kind: "tool", toolUseId: "t1", toolName: "Read", input: { path: "a.ts" }, status: "running" } }),
      emit({ type: "activity", activity: { kind: "tool", toolUseId: "t1", toolName: "Read", input: { path: "a.ts" }, status: "ok", output: "42 lines" } }),
      emit({ type: "usage", usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.5 }, contextUsage: { used: 900, window: 200_000 } }),
      emit({ type: "settled", status: "completed" }),
    );
    const requested = pick((await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "hi" })).events, "turn.requested");
    await h.reactor.drain();

    const model = h.engine.getModel();
    const turn = model.turns[requested.turn.id];
    expect(turn).toMatchObject({ status: "completed", provider: "claude", model: "fake-model" });
    expect(turn?.startedAt).toBeDefined();
    expect(turn?.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 });

    const thread = model.threads[h.threadId];
    expect(thread).toMatchObject({ status: "idle", nativeSessionId: "sess-1", totalCostUsd: 0.5, contextUsage: { used: 900, window: 200_000 } });

    const assistant = (model.threadMessages[h.threadId] ?? []).map((id) => model.messages[id]).filter((m) => m?.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatchObject({ text: "Hello", streaming: false });

    const activities = activitiesOf(model, h.threadId);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ kind: "tool", toolUseId: "t1", status: "ok", output: "42 lines" });

    expect(h.control.sessions[0]?.inputs[0]).toEqual({ text: "hi" });
  });

  it("reuses the session and resumes it on the next turn", async () => {
    const h = await harness();
    h.control.script(emit({ type: "session", nativeSessionId: "sess-1" }), emit({ type: "settled", status: "completed" }));
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "one" });
    await h.reactor.drain();
    h.control.script(emit({ type: "settled", status: "completed" }));
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "two" });
    await h.reactor.drain();
    expect(h.control.opened).toHaveLength(1);
    expect(h.control.sessions[0]?.inputs.map((i) => i.text)).toEqual(["one", "two"]);
  });
});

describe("ProviderReactor: approvals and questions", () => {
  it("raises attention, forwards the decision and clears attention", async () => {
    const h = await harness();
    h.control.script(
      emit({ type: "activity", activity: { kind: "approval", requestId: "r1", toolName: "Bash", input: { command: "rm -rf /" }, status: "pending" } }),
      awaitApproval("r1"),
      emit({ type: "settled", status: "completed" }),
    );
    const pending = waitFor(h.engine, (e) => e.type === "activity.upserted" && e.activity.kind === "approval");
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "danger" });
    await pending;

    expect(h.engine.getModel().threads[h.threadId]?.attention).toBe("approval");

    await h.engine.dispatch({ type: "approval.respond", threadId: h.threadId, requestId: "r1", decision: "accept" });
    await h.control.when("approval:r1");
    await h.reactor.drain();

    expect(h.control.approvals).toEqual([{ requestId: "r1", decision: "accept" }]);
    const model = h.engine.getModel();
    expect(model.threads[h.threadId]?.attention).toBeUndefined();
    expect(activitiesOf(model, h.threadId)[0]).toMatchObject({ kind: "approval", status: "resolved", decision: "accept", toolName: "Bash" });
  });

  it("forwards user-input answers to the same activity row", async () => {
    const h = await harness();
    h.control.script(
      emit({ type: "activity", activity: { kind: "user-input", requestId: "q1", questions: [{ id: "a", text: "Which?" }], status: "pending" } }),
      emit({ type: "settled", status: "completed" }),
    );
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "ask" });
    await h.reactor.drain();
    // the turn settled, but the session is still open: the answer still reaches the driver
    const model = h.engine.getModel();
    expect(activitiesOf(model, h.threadId)[0]).toMatchObject({ kind: "user-input", requestId: "q1" });
  });
});

describe("ProviderReactor: interrupt and failure", () => {
  it("interrupts the live turn", async () => {
    const h = await harness();
    h.control.script(
      emit({ type: "assistant.delta", messageKey: "m0", delta: "working" }),
      awaitInterrupt(),
      emit({ type: "settled", status: "interrupted" }),
    );
    const streaming = waitFor(h.engine, (e) => e.type === "assistant.delta");
    const requested = pick((await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "go" })).events, "turn.requested");
    await streaming;

    await h.engine.dispatch({ type: "turn.interrupt", threadId: h.threadId });
    await h.control.when("interrupt");
    await h.reactor.drain();

    expect(h.control.interrupts).toEqual([h.threadId]);
    const model = h.engine.getModel();
    expect(model.turns[requested.turn.id]?.status).toBe("interrupted");
    expect(model.threads[h.threadId]?.status).toBe("interrupted");
  });

  it("settles with an error activity when the driver throws", async () => {
    const h = await harness();
    h.control.script(emit({ type: "assistant.delta", messageKey: "m0", delta: "partial" }), throwStep("boom"));
    const requested = pick((await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "go" })).events, "turn.requested");
    await h.reactor.drain();

    const model = h.engine.getModel();
    expect(model.turns[requested.turn.id]).toMatchObject({ status: "error", error: "boom" });
    expect(model.threads[h.threadId]?.status).toBe("error");
    expect(activitiesOf(model, h.threadId)[0]).toMatchObject({ kind: "error", text: "boom" });
  });

  it("settles with an error when no driver is registered for the provider", async () => {
    const h = await harness();
    const created = pick((await h.engine.dispatch({ type: "thread.create", projectId: h.projectId, provider: "pi" })).events, "thread.created");
    const requested = pick((await h.engine.dispatch({ type: "turn.request", threadId: created.thread.id, text: "go" })).events, "turn.requested");
    await h.reactor.drain();
    expect(h.engine.getModel().turns[requested.turn.id]).toMatchObject({ status: "error", error: "no driver registered for pi" });
  });
});

describe("ProviderReactor: plans", () => {
  it("records a proposed plan and never implements it on its own", async () => {
    const h = await harness();
    h.control.script(
      emit({ type: "plan.progress", steps: [{ text: "look around", status: "in_progress" }] }),
      emit({ type: "plan.proposed", markdown: "## Rewrite the parser\n\n- step one" }),
      emit({ type: "settled", status: "completed" }),
    );
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "plan it" });
    await h.reactor.drain();

    const model = h.engine.getModel();
    const plans = Object.values(model.plans);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ threadId: h.threadId, status: "proposed" });
    expect(model.threads[h.threadId]?.attention).toBe("plan");
    expect(Object.values(model.threads)).toHaveLength(1);
  });

  it("runs the implementation thread's turn on the driver", async () => {
    const h = await harness();
    h.control.script(emit({ type: "plan.proposed", markdown: "## Rewrite the parser\n\n- step one" }), emit({ type: "settled", status: "completed" }));
    await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "plan it" });
    await h.reactor.drain();
    const planId = Object.keys(h.engine.getModel().plans)[0] ?? "";

    h.control.script(emit({ type: "assistant.delta", messageKey: "m0", delta: "on it" }), emit({ type: "settled", status: "completed" }));
    const events = (await h.engine.dispatch({ type: "plan.implement", planId, provider: "claude", mode: "auto" })).events;
    const created = pick(events, "thread.created");
    await h.reactor.drain();

    const model = h.engine.getModel();
    expect(created.thread).toMatchObject({ parentThreadId: h.threadId, title: "Rewrite the parser", mode: "auto" });
    expect(model.plans[planId]).toMatchObject({ status: "implemented", implementationThreadId: created.thread.id });
    expect(model.threads[created.thread.id]?.status).toBe("idle");

    const session = h.control.sessionFor(created.thread.id);
    expect(session?.options.cwd).toBe("/repo");
    expect(session?.inputs[0]?.text.startsWith("Implement the following plan.\n\n## Rewrite the parser")).toBe(true);
    const texts = (model.threadMessages[created.thread.id] ?? []).map((id) => model.messages[id]?.text);
    expect(texts).toContain("on it");
  });
});

describe("ProviderReactor: interrupt watchdog", () => {
  /** Drives a turn to the point where the driver is suspended and an interrupt has been sent. */
  async function interruptedTurn(clock: ManualClock): Promise<{ h: Harness; turnId: string }> {
    const h = await harness({ schedule: clock.schedule, interruptTimeoutMs: 30_000 });
    // the driver stalls on an approval nobody answers, so it never notices the interrupt
    h.control.script(emit({ type: "assistant.delta", messageKey: "m0", delta: "working" }), awaitApproval("never-answered"));
    const requested = pick((await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "go" })).events, "turn.requested");
    await waitFor(h.engine, (e) => e.type === "assistant.delta");
    await h.engine.dispatch({ type: "turn.interrupt", threadId: h.threadId });
    await h.control.when("interrupt");
    return { h, turnId: requested.turn.id };
  }

  it("settles the turn and closes the session when the driver never honours the interrupt", async () => {
    const clock = new ManualClock();
    const { h, turnId } = await interruptedTurn(clock);
    expect(clock.pending).toBe(1);
    expect(h.engine.getModel().threads[h.threadId]).toMatchObject({ status: "running", interrupting: true });

    const settled = waitFor(h.engine, (e) => e.type === "turn.settled");
    const closed = h.control.when(`close:${h.threadId}`);
    clock.advance(30_000);
    expect(await settled).toMatchObject({ type: "turn.settled", turnId, status: "interrupted", error: INTERRUPT_TIMEOUT_ERROR });
    await closed;

    const model = h.engine.getModel();
    expect(model.turns[turnId]).toMatchObject({ status: "interrupted", error: INTERRUPT_TIMEOUT_ERROR });
    expect(model.threads[h.threadId]?.status).toBe("interrupted");
    expect(model.threads[h.threadId]?.interrupting).toBeUndefined();
    expect(h.control.closed).toContain(h.threadId);
  });

  it("does not fire before the grace period is up", async () => {
    const clock = new ManualClock();
    const { h, turnId } = await interruptedTurn(clock);
    clock.advance(29_999);
    expect(clock.pending).toBe(1);
    expect(h.engine.getModel().turns[turnId]?.status).toBe("running");
  });

  it("cancels the watchdog when the driver does honour the interrupt", async () => {
    const clock = new ManualClock();
    const h = await harness({ schedule: clock.schedule, interruptTimeoutMs: 30_000 });
    h.control.script(
      emit({ type: "assistant.delta", messageKey: "m0", delta: "working" }),
      awaitInterrupt(),
      emit({ type: "settled", status: "interrupted" }),
    );
    const streaming = waitFor(h.engine, (e) => e.type === "assistant.delta");
    const requested = pick((await h.engine.dispatch({ type: "turn.request", threadId: h.threadId, text: "go" })).events, "turn.requested");
    await streaming;
    await h.engine.dispatch({ type: "turn.interrupt", threadId: h.threadId });
    await h.reactor.drain();

    expect(clock.pending).toBe(0);
    expect(h.engine.getModel().turns[requested.turn.id]?.status).toBe("interrupted");
    expect(h.control.closed).not.toContain(h.threadId);
  });
});
