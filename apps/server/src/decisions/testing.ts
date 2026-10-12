import type { Engine } from "../orchestration/engine.ts";
import type { CancelTimer } from "../provider/reactor.ts";

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
