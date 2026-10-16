import type { Engine } from "../orchestration/engine.ts";
import type { CancelTimer } from "../provider/reactor.ts";
import { noneVerdict, unitsOf, type Judge, type JudgeBackend, type JudgeCall, type JudgeQuestion, type JudgeUnit, type JudgeVerdict } from "./judge.ts";

/** Timers the test fires by hand. */
export class ManualClock {
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

  advance(ms: number): void {
    this.now += ms;
    const due = this.#pending.filter((e) => e.at <= this.now);
    this.#pending = this.#pending.filter((e) => e.at > this.now);
    for (const e of due) e.fn();
  }
}

/** Creates a project and `n` threads that each ran one settled turn. */
export async function seedThreads(engine: Engine, n: number): Promise<{ projectId: string; threadIds: string[]; turnIds: string[] }> {
  const created = await engine.dispatch({ type: "project.create", title: "P", rootPath: "/repo" });
  const projectId = (created.events.find((r) => r.event.type === "project.created")?.event as { project: { id: string } }).project.id;
  const threadIds: string[] = [];
  const turnIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = await engine.dispatch({ type: "thread.create", projectId, provider: "claude", title: `thread ${i}` });
    const threadId = (t.events.find((r) => r.event.type === "thread.created")?.event as { thread: { id: string } }).thread.id;
    const r = await engine.dispatch({ type: "turn.request", threadId, text: `do thing ${i}` });
    const turnId = (r.events.find((e) => e.event.type === "turn.requested")?.event as { turn: { id: string } }).turn.id;
    await engine.dispatch({ type: "turn.start", turnId, provider: "claude" });
    threadIds.push(threadId);
    turnIds.push(turnId);
  }
  return { projectId, threadIds, turnIds };
}

/** A judge that answers from a script keyed by verdict id; unscripted units get `none`. Records every question. */
export function fakeJudge(script: Record<string, Partial<JudgeVerdict>>, options: { enabled?: boolean } = {}): Pick<Judge, "ask" | "enabled"> & { questions: JudgeQuestion[] } {
  const questions: JudgeQuestion[] = [];
  return {
    questions,
    enabled: () => options.enabled ?? true,
    ask: async (question) => {
      questions.push(question);
      return unitsOf(question).map((u) => {
        const scripted = script[u.id];
        return scripted === undefined ? noneVerdict(u.id) : { id: u.id, confidence: 1, source: "jev" as const, tokens: 0, elapsedMs: 0, ...scripted };
      });
    },
  };
}

/** A backend answering each unit through `answer`; records every batch of calls it got. */
export function fakeBackend(
  name: "jev" | "fallback",
  answer: (unit: JudgeUnit, call: JudgeCall) => Partial<JudgeVerdict> | Error,
  options: { available?: () => boolean } = {},
): JudgeBackend & { calls: JudgeCall[][] } {
  const calls: JudgeCall[][] = [];
  return {
    name,
    calls,
    available: options.available ?? (() => true),
    ask: async (batch) => {
      calls.push(batch);
      return batch.flatMap((call) =>
        call.units.map((u) => {
          const a = answer(u, call);
          if (a instanceof Error) return { id: u.id, confidence: 0, source: name === "jev" ? ("none" as const) : ("fallback" as const), tokens: 0, elapsedMs: 0, error: a.message };
          return { id: u.id, confidence: 1, source: name, tokens: 0, elapsedMs: 0, ...a };
        }),
      );
    },
  };
}
