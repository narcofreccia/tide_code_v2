import { afterEach, describe, expect, it } from "vitest";
import type { Message, ReadModel } from "@tide/contracts";
import { createApp, type App } from "../app.ts";
import { openDatabase } from "../db/sqlite.ts";
import { baseConfig } from "../vcs/testing/vcsHarness.ts";
import { createFakeDriver, emit } from "../provider/testing/fakeDriver.ts";
import {
  DELEGATE_REPLY_CHARS,
  DelegateWaits,
  DelegationReactor,
  delegatesFinishedText,
  type CancelTimer,
} from "./delegation.ts";
import { Engine } from "./engine.ts";
import { EventStore } from "./store.ts";

interface Timer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

function manualTimers(): { timers: Timer[]; schedule: (fn: () => void, ms: number) => CancelTimer; fire: () => void } {
  const timers: Timer[] = [];
  return {
    timers,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
    fire: () => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    },
  };
}

interface Setup {
  engine: Engine;
  reactor: DelegationReactor;
  waits: DelegateWaits;
  clock: ReturnType<typeof manualTimers>;
  parentId: string;
  model(): ReadModel;
  delegate(title: string): Promise<{ threadId: string; turnId: string }>;
  finish(turnId: string, reply: string, status?: "completed" | "error", error?: string): Promise<void>;
  settle(): Promise<void>;
}

async function setup(): Promise<Setup> {
  const engine = new Engine({ store: new EventStore(await openDatabase(":memory:")), now: () => 1_000 });
  const project = (await engine.dispatch({ type: "project.create", title: "P", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project");
  const parent = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude", title: "Lead" })).events[0]?.event;
  if (parent?.type !== "thread.created") throw new Error("expected thread");
  const waits = new DelegateWaits();
  const clock = manualTimers();
  const reactor = new DelegationReactor({ engine, waits, schedule: clock.schedule, grayZone: () => ({ low: 0.6, high: 0.85 }), log: () => undefined });
  reactor.start();
  let n = 0;
  const s: Setup = {
    engine,
    reactor,
    waits,
    clock,
    parentId: parent.thread.id,
    model: () => engine.getModel(),
    async delegate(title) {
      const r = await engine.dispatch({ type: "thread.delegate", fromThreadId: parent.thread.id, provider: "codex", prompt: "do it", title });
      const created = r.events.find((x) => x.event.type === "thread.created")?.event;
      const requested = r.events.find((x) => x.event.type === "turn.requested")?.event;
      if (created?.type !== "thread.created" || requested?.type !== "turn.requested") throw new Error("expected a delegate");
      await engine.dispatch({ type: "turn.start", turnId: requested.turn.id, provider: "codex" });
      return { threadId: created.thread.id, turnId: requested.turn.id };
    },
    async finish(turnId, reply, status = "completed", error) {
      await engine.dispatch({ type: "assistant.append", turnId, messageId: `m${++n}`, delta: reply });
      await engine.dispatch({ type: "turn.settle", turnId, status, ...(error !== undefined ? { error } : {}) });
    },
    async settle() {
      await reactor.drain();
    },
  };
  return s;
}

const parentPrompts = (s: Setup): Message[] =>
  Object.values(s.model().messages).filter((m) => m.threadId === s.parentId && m.role === "user" && m.notification !== undefined);

describe("DelegationReactor — wake-ups", () => {
  it("wakes an idle parent once the delegate settles, after the batch window", async () => {
    const s = await setup();
    const d = await s.delegate("Fix types");
    await s.finish(d.turnId, "All green.");
    await s.settle();
    expect(parentPrompts(s)).toEqual([]);
    expect(s.clock.timers.map((t) => t.ms)).toEqual([2_000]);
    s.clock.fire();
    await s.settle();
    const [prompt] = parentPrompts(s);
    expect(prompt?.notification).toEqual({ source: "delegate", summary: "Fix types finished" });
    expect(prompt?.text).toBe(`Delegate "Fix types" (codex) finished: completed. Last reply:\nAll green.\nUse tide_delegate_status / tide_thread_read ${d.threadId} for details.`);
    expect(s.model().threads[s.parentId]?.status).toBe("running");
    expect(s.model().turns[prompt?.turnId ?? ""]?.status).toBe("requested");
  });

  it("batches delegates that settle within the window into one message", async () => {
    const s = await setup();
    const a = await s.delegate("A");
    const b = await s.delegate("B");
    await s.finish(a.turnId, "done a");
    await s.finish(b.turnId, "broke", "error", "tool crashed");
    expect(s.clock.timers).toHaveLength(1);
    s.clock.fire();
    await s.settle();
    const prompts = parentPrompts(s);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.notification?.summary).toBe("2 delegates finished");
    expect(prompts[0]?.text).toContain(`Delegate "A" (codex) finished: completed.`);
    expect(prompts[0]?.text).toContain(`Delegate "B" (codex) finished: error (tool crashed).`);
  });

  it("queues the wake-up behind a running parent turn", async () => {
    const s = await setup();
    const d = await s.delegate("Child");
    await s.engine.dispatch({ type: "turn.request", threadId: s.parentId, text: "keep going" });
    await s.finish(d.turnId, "ok");
    s.clock.fire();
    await s.settle();
    const [prompt] = parentPrompts(s);
    expect(s.model().turns[prompt?.turnId ?? ""]?.status).toBe("queued");
  });

  it("reports a usage limit once, not the error settle before it", async () => {
    const s = await setup();
    const d = await s.delegate("Child");
    await s.finish(d.turnId, "partial", "error", "usage limit reached");
    await s.engine.dispatch({ type: "thread.limited", threadId: d.threadId });
    s.clock.fire();
    await s.settle();
    const prompts = parentPrompts(s);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.text).toContain("finished: hit its usage limit.");
  });

  it("stays quiet while the delegate still has a queued turn to run", async () => {
    const s = await setup();
    const d = await s.delegate("Child");
    await s.engine.dispatch({ type: "turn.request", threadId: d.threadId, text: "and then this" });
    await s.finish(d.turnId, "first part");
    expect(s.clock.timers).toEqual([]);
  });

  it("never wakes an archived parent", async () => {
    const s = await setup();
    const d = await s.delegate("Child");
    await s.engine.dispatch({ type: "thread.archive", threadId: s.parentId, keepWorktree: true });
    await s.finish(d.turnId, "ok");
    s.clock.fire();
    await s.settle();
    expect(parentPrompts(s)).toEqual([]);
  });

  it("skips a parent blocked in a wait on that child, and wakes it once the wait ended", async () => {
    const s = await setup();
    const d = await s.delegate("Child");
    const end = s.waits.begin(s.parentId, d.threadId);
    await s.finish(d.turnId, "ok");
    expect(s.clock.timers).toEqual([]);
    end();
    const again = (await s.engine.dispatch({ type: "turn.request", threadId: d.threadId, text: "more" })).events.at(-1)?.event;
    if (again?.type !== "turn.requested") throw new Error("expected turn.requested");
    await s.engine.dispatch({ type: "turn.start", turnId: again.turn.id, provider: "codex" });
    await s.finish(again.turn.id, "more done");
    expect(s.clock.timers).toHaveLength(1);
  });
});

describe("DelegationReactor — judge verdict", () => {
  const verdict = (label: string, confidence: number) => ({ site: "delegates" as const, label, confidence, source: "jev" as const, at: 2_000 });

  it("adds the judge line and label to the summary when the verdict landed and is confident", async () => {
    const s = await setup();
    const d = await s.delegate("Fix types");
    await s.finish(d.turnId, "All green.");
    await s.engine.dispatch({ type: "judge.record", target: { kind: "thread", id: d.threadId }, verdict: verdict("done", 0.912) });
    s.clock.fire();
    await s.settle();
    const [prompt] = parentPrompts(s);
    expect(prompt?.notification).toEqual({ source: "delegate", summary: "Fix types finished — done" });
    expect(prompt?.text).toBe(`Delegate "Fix types" (codex) finished: completed. Last reply:\nAll green.\nJudge: done (jev 0.91)\nUse tide_delegate_status / tide_thread_read ${d.threadId} for details.`);
  });

  it("ships without the verdict when it is missing at flush or below the gray zone's low", async () => {
    const s = await setup();
    const a = await s.delegate("A");
    const b = await s.delegate("B");
    await s.finish(a.turnId, "a");
    await s.finish(b.turnId, "b");
    await s.engine.dispatch({ type: "judge.record", target: { kind: "thread", id: b.threadId }, verdict: verdict("failed", 0.4) });
    s.clock.fire();
    await s.settle();
    const [prompt] = parentPrompts(s);
    expect(prompt?.text).not.toContain("Judge:");
    expect(prompt?.notification?.summary).toBe("2 delegates finished");
  });
});

describe("DelegationReactor — child questions", () => {
  async function ask(s: Setup, d: { threadId: string; turnId: string }): Promise<void> {
    await s.engine.dispatch({
      type: "activity.upsert",
      activity: { id: "q1", kind: "user-input", threadId: d.threadId, turnId: d.turnId, requestId: "r1", questions: [{ id: "a", text: "Which branch?" }], status: "pending", createdAt: 1, updatedAt: 1 },
    });
    await s.settle();
  }

  it("relays a pending question at once, and only once", async () => {
    const s = await setup();
    const d = await s.delegate("Child");
    await ask(s, d);
    await ask(s, d); // the same activity upserted again
    const prompts = parentPrompts(s);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.notification).toEqual({ source: "child-question", summary: "Child asks a question" });
    expect(prompts[0]?.text).toBe(`Delegate "Child" asks: Which branch?; answer with tide_pending_respond threadId=${d.threadId} requestId=r1 or ask the user`);
  });

  it("dequeues the relay when the question is answered before it ran", async () => {
    const s = await setup();
    const d = await s.delegate("Child");
    await s.engine.dispatch({ type: "turn.request", threadId: s.parentId, text: "busy" });
    await ask(s, d);
    const relay = parentPrompts(s)[0];
    expect(s.model().turns[relay?.turnId ?? ""]?.status).toBe("queued");
    await s.engine.dispatch({ type: "user-input.respond", threadId: d.threadId, requestId: "r1", answers: { a: "main" } });
    await s.settle();
    expect(s.model().turns[relay?.turnId ?? ""]).toBeUndefined();
  });

  it("leaves a relay that already started alone", async () => {
    const s = await setup();
    const d = await s.delegate("Child");
    await ask(s, d);
    const relay = parentPrompts(s)[0];
    await s.engine.dispatch({ type: "user-input.respond", threadId: d.threadId, requestId: "r1", answers: { a: "main" } });
    await s.settle();
    expect(s.model().turns[relay?.turnId ?? ""]?.status).toBe("requested");
  });
});

describe("delegatesFinishedText", () => {
  it("clips the last reply and says when there was none", () => {
    const text = delegatesFinishedText([
      { threadId: "t1", title: "Long", provider: "pi", outcome: "completed", lastReply: "x".repeat(DELEGATE_REPLY_CHARS + 50) },
      { threadId: "t2", title: "Quiet", provider: "claude", outcome: "interrupted" },
    ]);
    expect(text).toContain(`${"x".repeat(DELEGATE_REPLY_CHARS)}…\n`);
    expect(text).not.toContain("x".repeat(DELEGATE_REPLY_CHARS + 1));
    expect(text).toContain(`Delegate "Quiet" (claude) finished: interrupted. Last reply:\n(no reply)`);
  });
});

describe("DelegationReactor — in the app, with the fake driver", () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("a delegate run by the harness wakes its parent with the reply", async () => {
    const clock = manualTimers();
    const { driver, control } = createFakeDriver("claude");
    app = await createApp({
      config: baseConfig("/tmp/tide-delegation-test"),
      listen: false,
      log: () => undefined,
      delegationSchedule: clock.schedule,
      registerDrivers: (registry) => registry.register(driver),
    });
    const engine = app.engine;
    const project = (await engine.dispatch({ type: "project.create", title: "P", rootPath: "/tmp/tide-delegation-test-repo" })).events[0]?.event;
    if (project?.type !== "project.created") throw new Error("expected project");
    const parent = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude", title: "Lead" })).events[0]?.event;
    if (parent?.type !== "thread.created") throw new Error("expected thread");

    control.script(emit({ type: "assistant.delta", messageKey: "m0", delta: "Found it in auth.ts" }), emit({ type: "settled", status: "completed" }));
    const r = await engine.dispatch({ type: "thread.delegate", fromThreadId: parent.thread.id, provider: "claude", prompt: "look", title: "Scout", useWorktree: false });
    const child = r.events.find((x) => x.event.type === "thread.created")?.event;
    if (child?.type !== "thread.created") throw new Error("expected delegate");
    await app.reactor.drain();
    await app.delegation.drain();
    expect(app.engine.getModel().threads[child.thread.id]?.status).toBe("idle");

    control.script(emit({ type: "settled", status: "completed" }));
    clock.fire();
    await app.delegation.drain();
    await app.reactor.drain();
    const wake = Object.values(app.engine.getModel().messages).find((m) => m.threadId === parent.thread.id && m.notification?.source === "delegate");
    expect(wake?.text).toContain(`Delegate "Scout" (claude) finished: completed. Last reply:\nFound it in auth.ts`);
    expect(control.opened.map((o) => o.threadId)).toEqual([child.thread.id, parent.thread.id]);
  });
});
