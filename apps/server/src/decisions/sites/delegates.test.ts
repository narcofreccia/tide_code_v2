import { describe, expect, it } from "vitest";
import type { JudgeVerdict } from "../judge.ts";
import { fakeJudge } from "../testing.ts";
import { DelegatesSite } from "./delegates.ts";
import { memoryEngine, seedProject } from "./harness.testutil.ts";

type Script = Record<string, Partial<JudgeVerdict>>;

async function rig(options: { enabled?: boolean; role?: string; verdict?: Partial<JudgeVerdict> } = {}) {
  const engine = await memoryEngine();
  const projectId = await seedProject(engine);
  const parent = (await engine.dispatch({ type: "thread.create", projectId, provider: "claude", title: "Lead" })).events[0]?.event;
  if (parent?.type !== "thread.created") throw new Error("thread");
  const script: Script = {};
  const judge = fakeJudge(script, { enabled: options.enabled ?? true });
  const site = new DelegatesSite({ engine, judge, now: () => 5_000, log: () => undefined });
  site.start();
  const r = await engine.dispatch({
    type: "thread.delegate",
    fromThreadId: parent.thread.id,
    provider: "codex",
    prompt: "fix the build please",
    title: "Fixer",
    ...(options.role !== undefined ? { role: options.role } : {}),
  });
  const created = r.events.find((x) => x.event.type === "thread.created")?.event;
  const requested = r.events.find((x) => x.event.type === "turn.requested")?.event;
  if (created?.type !== "thread.created" || requested?.type !== "turn.requested") throw new Error("delegate");
  const threadId = created.thread.id;
  const turnId = requested.turn.id;
  if (options.verdict !== undefined) script[`delegate:${threadId}:${turnId}`] = options.verdict;
  await engine.dispatch({ type: "turn.start", turnId, provider: "codex" });
  return { engine, site, judge, projectId, threadId, turnId };
}

describe("DelegatesSite", () => {
  it("asks one clipped label question when a delegate settles", async () => {
    const r = await rig();
    await r.engine.dispatch({ type: "assistant.append", turnId: r.turnId, messageId: "m1", delta: "x".repeat(3000) });
    await r.engine.dispatch({ type: "turn.settle", turnId: r.turnId, status: "error", error: "boom" });
    await r.site.drain();
    expect(r.judge.questions).toHaveLength(1);
    const q = r.judge.questions[0] as unknown as { id: string; site: string; kind: string; state: Record<string, string>; labels: Record<string, string> };
    expect(q).toMatchObject({ id: `delegate:${r.threadId}:${r.turnId}`, site: "delegates", kind: "label" });
    expect(Object.keys(q.labels)).toEqual(["done", "blocked", "needs-user", "failed"]);
    expect(q.state["task"]).toContain("fix the build please");
    expect(q.state["lastReply"]?.length).toBe(1501);
    expect(q.state["outcome"]).toBe("error");
    expect(q.state["error"]).toBe("boom");
    // unscripted -> `none` -> nothing recorded
    expect(r.engine.getModel().threads[r.threadId]?.judge).toBeUndefined();
  });

  it("uses pass/fail/inconclusive for reviewer roles", async () => {
    const r = await rig({ role: "code review" });
    await r.engine.dispatch({ type: "turn.settle", turnId: r.turnId, status: "completed" });
    await r.site.drain();
    const q = r.judge.questions[0] as unknown as { labels: Record<string, string> };
    expect(Object.keys(q.labels)).toEqual(["pass", "fail", "inconclusive"]);
  });

  it("records the verdict on the thread", async () => {
    const r = await rig({ verdict: { label: "blocked", confidence: 0.9 } });
    await r.engine.dispatch({ type: "turn.settle", turnId: r.turnId, status: "completed" });
    await r.site.drain();
    expect(r.engine.getModel().threads[r.threadId]?.judge).toEqual({ site: "delegates", label: "blocked", confidence: 0.9, source: "jev", at: 5_000 });
  });

  it("does nothing when the site is disabled", async () => {
    const r = await rig({ enabled: false });
    await r.engine.dispatch({ type: "turn.settle", turnId: r.turnId, status: "completed" });
    await r.site.drain();
    expect(r.judge.questions).toHaveLength(0);
  });

  it("ignores threads that are not delegates", async () => {
    const r = await rig();
    const t = (await r.engine.dispatch({ type: "thread.create", projectId: r.projectId, provider: "claude", title: "Solo" })).events[0]?.event;
    if (t?.type !== "thread.created") throw new Error("thread");
    const turn = (await r.engine.dispatch({ type: "turn.request", threadId: t.thread.id, text: "hi" })).events.find((e) => e.event.type === "turn.requested")?.event;
    if (turn?.type !== "turn.requested") throw new Error("turn");
    await r.engine.dispatch({ type: "turn.start", turnId: turn.turn.id, provider: "claude" });
    await r.engine.dispatch({ type: "turn.settle", turnId: turn.turn.id, status: "completed" });
    await r.site.drain();
    expect(r.judge.questions).toHaveLength(0);
  });
});
