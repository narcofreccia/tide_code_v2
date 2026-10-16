import { afterEach, describe, expect, it } from "vitest";
import type { EventOf } from "@tide/contracts";
import { openDatabase } from "../../db/sqlite.ts";
import { Engine } from "../../orchestration/engine.ts";
import { EventStore } from "../../orchestration/store.ts";
import { noneVerdict, unitsOf, type Judge, type JudgeQuestion, type JudgeVerdict, type PerItemQuestion } from "../judge.ts";
import { HandoffSite } from "./handoff.ts";

const CAP = 1_024;
const stores: EventStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

type Answer = Partial<JudgeVerdict> | undefined;

/** Answers each item from its state; records the questions. */
function judgeFrom(answer: (state: { kind: string; turn: number; text: string }) => Answer, options: { enabled?: boolean; gate?: Promise<void> } = {}): Pick<Judge, "ask" | "enabled"> & { questions: JudgeQuestion[] } {
  const questions: JudgeQuestion[] = [];
  return {
    questions,
    enabled: () => options.enabled ?? true,
    ask: async (q) => {
      questions.push(q);
      await options.gate;
      const items = new Map((q as PerItemQuestion).items.map((i) => [i.key, i.state as { kind: string; turn: number; text: string }]));
      return unitsOf(q).map((u) => {
        const a = answer(items.get(u.item ?? "") ?? { kind: "", turn: 0, text: "" });
        return a === undefined ? noneVerdict(u.id) : { id: u.id, confidence: 1, source: "jev" as const, tokens: 0, elapsedMs: 0, ...a };
      });
    },
  };
}

const fill = (c: string): string => c.repeat(200);

/** A thread with six settled turns, switched to codex: the handoff (cap 1024 bytes) has room for two items beyond the priority ones (first and last request). */
async function setup(judge: Pick<Judge, "ask" | "enabled">, logs: unknown[] = []): Promise<{ engine: Engine; site: HandoffSite; threadId: string; handoff: () => EventOf<"handoff.recorded">["handoff"] }> {
  const store = new EventStore(await openDatabase(":memory:"));
  stores.push(store);
  const engine = new Engine({ store, handoffCap: CAP });
  const site = new HandoffSite({ engine, judge, handoffCap: CAP, now: () => 42, log: (msg) => void logs.push(msg) });
  site.start();
  const p = await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" });
  const projectId = (p.events[0]?.event as EventOf<"project.created">).project.id;
  const t = await engine.dispatch({ type: "thread.create", projectId, provider: "claude", title: "Src" });
  const threadId = (t.events[0]?.event as EventOf<"thread.created">).thread.id;
  for (const text of [fill("a"), fill("b"), fill("N"), fill("d"), fill("e"), fill("f")]) {
    const r = await engine.dispatch({ type: "turn.request", threadId, text });
    const turnId = (r.events.find((e) => e.event.type === "turn.requested")?.event as EventOf<"turn.requested">).turn.id;
    await engine.dispatch({ type: "turn.start", turnId, provider: "claude" });
    await engine.dispatch({ type: "turn.settle", turnId, status: "completed" });
  }
  let recorded: EventOf<"handoff.recorded">["handoff"] | undefined;
  engine.subscribe((r) => {
    if (r.event.type === "handoff.recorded") recorded = r.event.handoff;
  });
  await engine.dispatch({ type: "thread.update", threadId, provider: "codex" });
  return {
    engine,
    site,
    threadId,
    handoff: () => {
      if (!recorded) throw new Error("no handoff recorded");
      return recorded;
    },
  };
}

describe("HandoffSite", () => {
  it("re-selects an omitting handoff in the judge's order and records the verdict summary", async () => {
    const judge = judgeFrom((s) => (s.text.startsWith("N") ? { label: "keep", confidence: 0.9 } : { label: "drop", confidence: 0.7 }));
    const { engine, site, handoff } = await setup(judge);
    const h = handoff();
    expect(h.text).toContain(fill("d"));
    expect(h.text).not.toContain(fill("N"));
    await site.pending(h.id);
    const q = judge.questions[0] as PerItemQuestion;
    expect(q).toMatchObject({ site: "handoff", id: `handoff:${h.id}`, shared: { task: fill("a"), latest: fill("f") }, labels: { keep: "needed to continue", drop: "noise or superseded" } });
    expect(q.items.map((i) => (i.state as { turn: number }).turn)).toEqual([5, 4, 3, 2]);
    expect(q.items[0]?.state).toEqual({ kind: "user", turn: 5, text: fill("e") });
    const refined = engine.getModel().handoffs[h.id];
    expect(refined?.text).toContain(fill("N"));
    expect(refined?.text).not.toContain(fill("d"));
    expect(refined?.judge).toEqual({ kept: 4, dropped: 2, source: "jev", confidence: expect.closeTo(0.75, 10), at: 42 });
    expect(site.pending(h.id)).toBeUndefined();
  });

  it("does not dispatch when no backend answered", async () => {
    const judge = judgeFrom(() => undefined);
    const { engine, site, handoff } = await setup(judge);
    await site.pending(handoff().id);
    expect(judge.questions).toHaveLength(1);
    expect(engine.getModel().handoffs[handoff().id]?.judge).toBeUndefined();
  });

  it("stays out of the way when the site is off", async () => {
    const judge = judgeFrom(() => ({ label: "keep" }), { enabled: false });
    const { site, handoff } = await setup(judge);
    expect(site.pending(handoff().id)).toBeUndefined();
    expect(judge.questions).toHaveLength(0);
  });

  it("swallows the conflict when the handoff was delivered first", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const logs: unknown[] = [];
    const judge = judgeFrom(() => ({ label: "keep", confidence: 0.8 }), { gate });
    const { engine, site, threadId, handoff } = await setup(judge, logs);
    const r = await engine.dispatch({ type: "turn.request", threadId, text: "go" });
    const turnId = (r.events.find((e) => e.event.type === "turn.requested")?.event as EventOf<"turn.requested">).turn.id;
    await engine.dispatch({ type: "handoff.delivered", turnId, delivery: "inline" });
    open();
    await site.pending(handoff().id);
    expect(engine.getModel().handoffs[handoff().id]?.judge).toBeUndefined();
    expect(logs).toEqual(["[handoff-site] refine arrived after delivery; the recency selection was used"]);
  });
});
