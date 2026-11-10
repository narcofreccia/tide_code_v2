import type { Activity, Command } from "@tide/contracts";
import type { Engine } from "./engine.ts";

/** Small deterministic PRNG (mulberry32) so a "varied" history is the same on every run. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HistoryOptions {
  threads: number;
  turnsPerThread: number;
  /** text chunks per assistant message (reasoning gets half) */
  chunks?: number;
  seed?: number;
  /** stop the last turn of thread 0 mid-stream: running, with a pending approval */
  leaveRunning?: boolean;
}

export interface History {
  projectId: string;
  threadIds: string[];
  /** the turn left running when `leaveRunning` */
  runningTurnId?: string;
}

/**
 * Plays a varied, interleaved harness history through the real command path: per turn a
 * reasoning stream, a tool activity that runs and finishes in the middle of the text, text and
 * reasoning chunks of the same message interleaved, a second message, an approval asked and
 * answered, then the settle. Threads advance in a seeded random interleaving, so runs of one
 * message are broken by other threads' events.
 */
export async function playHistory(engine: Engine, options: HistoryOptions): Promise<History> {
  const rand = prng(options.seed ?? 7);
  const chunks = options.chunks ?? 8;
  const tag = `s${options.seed ?? 7}`;
  let clock = 10_000;
  const at = (): number => ++clock;
  const project = (await engine.dispatch({ type: "project.create", title: "P", rootPath: `/repo-${options.seed ?? 7}` })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project");
  const projectId = project.project.id;
  const threadIds: string[] = [];
  for (let i = 0; i < options.threads; i++) {
    const t = (await engine.dispatch({ type: "thread.create", projectId, provider: "claude", title: `T${i}` })).events[0]?.event;
    if (t?.type !== "thread.created") throw new Error("expected thread");
    threadIds.push(t.thread.id);
  }

  const history: History = { projectId, threadIds };
  // one lazily built step list per thread; each step is one command (or a lookup + command)
  const queues = threadIds.map((threadId, ti) => threadSteps(threadId, ti));
  function* threadSteps(threadId: string, ti: number): Generator<() => Promise<void>> {
    for (let n = 0; n < options.turnsPerThread; n++) {
      const last = options.leaveRunning === true && ti === 0 && n === options.turnsPerThread - 1;
      let turnId = "";
      const m1 = `msg-${tag}-${ti}-${n}-a`;
      const m2 = `msg-${tag}-${ti}-${n}-b`;
      const toolId = `tool-${tag}-${ti}-${n}`;
      yield async () => {
        const r = await engine.dispatch({ type: "turn.request", threadId, text: `prompt ${ti}.${n}` });
        const e = r.events.find((x) => x.event.type === "turn.requested")?.event;
        if (e?.type !== "turn.requested") throw new Error("expected turn.requested");
        turnId = e.turn.id;
      };
      yield () => send({ type: "turn.start", turnId, provider: "claude" });
      for (let c = 0; c < chunks / 2; c++) yield () => send({ type: "assistant.reasoning.append", turnId, messageId: m1, delta: `think${c} ` });
      for (let c = 0; c < chunks; c++) {
        if (c === 2) yield () => upsert(tool(threadId, turnId, toolId, "running"));
        if (c === 5) yield () => upsert(tool(threadId, turnId, toolId, "ok"));
        // reasoning and text of one message interleaved
        if (c % 3 === 1) yield () => send({ type: "assistant.reasoning.append", turnId, messageId: m1, delta: `more${c} ` });
        yield () => send({ type: "assistant.append", turnId, messageId: m1, delta: `t${ti}.${n}.${c} ` });
      }
      yield () => upsert(approval(threadId, turnId, `req-${tag}-${ti}-${n}`));
      if (last) {
        for (let c = 0; c < 3; c++) yield () => send({ type: "assistant.append", turnId, messageId: m2, delta: `partial${c} ` });
        yield async () => {
          history.runningTurnId = turnId;
        };
        return;
      }
      yield () => send({ type: "approval.respond", threadId, requestId: `req-${tag}-${ti}-${n}`, decision: "accept" });
      for (let c = 0; c < chunks; c++) yield () => send({ type: "assistant.append", turnId, messageId: m2, delta: `second${c} ` });
      yield () => send({ type: "turn.settle", turnId, status: n % 5 === 4 ? "interrupted" : "completed" });
    }
  }
  async function send(command: Command): Promise<void> {
    await engine.dispatch(command);
  }
  async function upsert(activity: Activity): Promise<void> {
    await engine.dispatch({ type: "activity.upsert", activity });
  }
  function tool(threadId: string, turnId: string, id: string, status: "running" | "ok"): Activity {
    return { id, threadId, turnId, kind: "tool", toolUseId: id, toolName: "Bash", input: { command: "ls" }, status, createdAt: at(), updatedAt: at() };
  }
  function approval(threadId: string, turnId: string, requestId: string): Activity {
    return { id: `act-${requestId}`, threadId, turnId, kind: "approval", requestId, toolName: "Bash", input: { command: "rm" }, status: "pending", createdAt: at(), updatedAt: at() };
  }

  const live = [...queues];
  while (live.length > 0) {
    const i = Math.floor(rand() * live.length);
    const next = live[i]?.next();
    if (next === undefined || next.done === true) {
      live.splice(i, 1);
      continue;
    }
    await next.value();
  }
  await engine.drain();
  return history;
}
