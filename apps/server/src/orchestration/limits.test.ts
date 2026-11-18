import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/sqlite.ts";
import { CommandError, Engine } from "./engine.ts";
import { isUsageLimitError, LimitsWorker, MAX_BACKOFF_MS, PROBE_AFTER_MS, type CancelTimer } from "./limits.ts";
import { EventStore } from "./store.ts";

async function setup(): Promise<{ engine: Engine; threadId: string; projectId: string; clock: { now: number }; addThread: (provider?: "claude" | "codex") => Promise<string> }> {
  const clock = { now: 1_000 };
  const engine = new Engine({ store: new EventStore(await openDatabase(":memory:")), now: () => clock.now });
  const project = (await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project");
  const addThread = async (provider: "claude" | "codex" = "claude"): Promise<string> => {
    const thread = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider })).events[0]?.event;
    if (thread?.type !== "thread.created") throw new Error("expected thread");
    return thread.thread.id;
  };
  return { engine, threadId: await addThread(), projectId: project.project.id, clock, addThread };
}

/** Limits `threadId` now with a "resume at reset" policy. */
async function limit(engine: Engine, threadId: string, resetsAt?: number): Promise<void> {
  await engine.dispatch({ type: "thread.limited", threadId, ...(resetsAt !== undefined ? { resetsAt } : {}) });
  await engine.dispatch({ type: "thread.limit-policy", threadId, resume: "reset" });
}

describe("isUsageLimitError", () => {
  it("matches harness limit wording and nothing else", () => {
    for (const text of ["Claude AI usage limit reached", "Rate limited, retry later", "insufficient_quota", "HTTP 429", "Too Many Requests"]) {
      expect(isUsageLimitError(text)).toBe(true);
    }
    expect(isUsageLimitError("line 4290 failed")).toBe(false);
    expect(isUsageLimitError("tool crashed")).toBe(false);
    expect(isUsageLimitError(undefined)).toBe(false);
  });
});

describe("LimitsWorker", () => {
  it("resumes a reset-policy thread once its window reopened, and only then", async () => {
    const { engine, threadId, clock } = await setup();
    await engine.dispatch({ type: "thread.limited", threadId, resetsAt: 5_000 });
    await engine.dispatch({ type: "thread.limit-policy", threadId, resume: "reset" });
    const worker = new LimitsWorker({ engine, now: () => clock.now });
    expect(await worker.tick()).toEqual([]);
    clock.now = 5_000;
    expect(await worker.tick()).toEqual([threadId]);
    const model = engine.getModel();
    expect(model.threads[threadId]?.limited).toBeUndefined();
    const prompt = Object.values(model.messages).find((m) => m.threadId === threadId && m.role === "user");
    expect(prompt?.notification?.source).toBe("restart");
    // cleared: nothing more to do
    expect(await worker.tick()).toEqual([]);
  });

  it("leaves manual-policy threads to the user", async () => {
    const { engine, threadId, clock } = await setup();
    await engine.dispatch({ type: "thread.limited", threadId, resetsAt: 500 });
    const worker = new LimitsWorker({ engine, now: () => clock.now });
    expect(await worker.tick()).toEqual([]);
    expect(engine.getModel().threads[threadId]?.limited).toBeDefined();
  });

  it("skips settled and running threads", async () => {
    const { engine, threadId, clock, addThread } = await setup();
    await limit(engine, threadId, 2_000);
    const busy = await addThread();
    await engine.dispatch({ type: "turn.request", threadId: busy, text: "go" });
    await limit(engine, busy, 2_000);
    // settling a limited thread clears its limit outright; a stale `limited` on a settled thread is still never acted on
    const model = engine.getModel();
    const thread = model.threads[threadId]!;
    const settledView = { ...model, threads: { ...model.threads, [threadId]: { ...thread, settledAt: 1_500 } } };
    const getModel = engine.getModel.bind(engine);
    engine.getModel = () => settledView;
    clock.now = 3_000;
    const worker = new LimitsWorker({ engine, now: () => clock.now });
    expect(await worker.tick()).toEqual([]);
    engine.getModel = getModel;
    expect(await worker.tick()).toEqual([threadId]);
  });

  it("resumes once the instance's window answered again, without a reset time", async () => {
    const { engine, threadId, clock, addThread } = await setup();
    await limit(engine, threadId);
    const worker = new LimitsWorker({ engine, now: () => clock.now });
    clock.now = 2_000;
    expect(await worker.tick()).toEqual([]);
    // another thread on the same account ran: the weekly gauge reports open again
    const other = await addThread();
    const turn = (await engine.dispatch({ type: "turn.request", threadId: other, text: "x" })).events.at(-1)?.event;
    if (turn?.type !== "turn.requested") throw new Error("expected a turn");
    await engine.dispatch({ type: "usage.report", turnId: turn.turn.id, rateLimit: { status: "ok", window: "weekly", at: 2_000 } });
    expect(await worker.tick()).toEqual([threadId]);
  });

  it("probes a limit with no reset time after an hour, then waits twice as long before the next probe", async () => {
    const { engine, threadId, clock } = await setup();
    await limit(engine, threadId);
    const worker = new LimitsWorker({ engine, now: () => clock.now });
    clock.now = 1_000 + PROBE_AFTER_MS - 1;
    expect(await worker.tick()).toEqual([]);
    clock.now = 1_000 + PROBE_AFTER_MS;
    expect(await worker.tick()).toEqual([threadId]);
    // the probe hit the wall again
    const turnId = engine.getModel().threads[threadId]?.latestTurnId ?? "";
    await engine.dispatch({ type: "turn.settle", turnId, status: "error", error: "usage limit" });
    const limitedAt = clock.now;
    await limit(engine, threadId);
    clock.now = limitedAt + PROBE_AFTER_MS;
    expect(await worker.tick()).toEqual([]);
    clock.now = limitedAt + 2 * PROBE_AFTER_MS;
    expect(await worker.tick()).toEqual([threadId]);
  });

  it("resumes one thread per instance per tick, oldest limit first", async () => {
    const { engine, threadId, clock, addThread } = await setup();
    await limit(engine, threadId, 2_000);
    clock.now = 1_100;
    const second = await addThread();
    await limit(engine, second, 2_000);
    const codex = await addThread("codex");
    await limit(engine, codex, 2_000);
    clock.now = 3_000;
    const worker = new LimitsWorker({ engine, now: () => clock.now });
    expect(await worker.tick()).toEqual([threadId, codex]);
    await engine.dispatch({ type: "turn.settle", turnId: engine.getModel().threads[threadId]?.latestTurnId ?? "", status: "completed" });
    expect(await worker.tick()).toEqual([second]);
  });

  it("retries a busy refusal next tick and backs off any other refusal, doubling up to an hour", async () => {
    const { engine, threadId, projectId, clock } = await setup();
    await limit(engine, threadId, 2_000);
    clock.now = 3_000;
    const dispatch = engine.dispatch.bind(engine);
    let refuse: string | undefined = "busy";
    engine.dispatch = (command) => (command.type === "thread.resume" && refuse !== undefined ? Promise.reject(new CommandError(refuse, "no")) : dispatch(command));
    const worker = new LimitsWorker({ engine, now: () => clock.now, intervalMs: 60_000 });
    expect(await worker.tick()).toEqual([]);
    refuse = undefined;
    expect(await worker.tick()).toEqual([threadId]);

    // a quota holds the project: the real refusal, backed off like any other
    await engine.dispatch({ type: "turn.settle", turnId: engine.getModel().threads[threadId]?.latestTurnId ?? "", status: "completed" });
    await limit(engine, threadId, 2_000);
    await engine.dispatch({ type: "quota.set", scope: "project", id: projectId, quota: { sharePct: 10, onExceed: "hold" } });
    await engine.dispatch({ type: "quota.meter", scope: "project", id: projectId, state: { status: "exceeded", usedPct: 120, basis: "share", over: ["claude"], at: clock.now } });
    const attempts: number[] = [];
    engine.dispatch = (command) => {
      if (command.type === "thread.resume") attempts.push(clock.now);
      return dispatch(command);
    };
    const start = clock.now;
    for (let t = start; t <= start + 190 * 60_000; t += 60_000) {
      clock.now = t;
      expect(await worker.tick()).toEqual([]);
    }
    const gapsMin = attempts.slice(1).map((at, i) => (at - (attempts[i] ?? 0)) / 60_000);
    expect(gapsMin).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    expect(MAX_BACKOFF_MS).toBe(60 * 60_000);
  });

  it("ticks on its own schedule and stops cleanly", async () => {
    const { engine } = await setup();
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const schedule = (fn: () => void, ms: number): CancelTimer => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    };
    const worker = new LimitsWorker({ engine, schedule });
    worker.start();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(60_000);
    worker.stop();
    expect(timers[0]?.cancelled).toBe(true);
  });
});
