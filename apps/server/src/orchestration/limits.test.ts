import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "./engine.ts";
import { isUsageLimitError, LimitsWorker, type CancelTimer } from "./limits.ts";
import { EventStore } from "./store.ts";

async function setup(): Promise<{ engine: Engine; threadId: string; clock: { now: number } }> {
  const clock = { now: 1_000 };
  const engine = new Engine({ store: new EventStore(await openDatabase(":memory:")), now: () => clock.now });
  const project = (await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project");
  const thread = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
  if (thread?.type !== "thread.created") throw new Error("expected thread");
  return { engine, threadId: thread.thread.id, clock };
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
