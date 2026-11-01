import type { ActivityOf } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { markChildrenLost } from "./background.ts";
import { Engine } from "./engine.ts";
import { EventStore } from "./store.ts";

type Child = ActivityOf<"child">;

/**
 * An engine with a lead thread and helpers to play a harness by hand: turns (user or harness),
 * replies, sub-agents that outlive their turn, reports and lost sub-agents. Given a `store`
 * that already holds a log, it replays it (a restart) instead of creating the lead again.
 */
export async function backgroundFixture(options: { store?: EventStore } = {}) {
  const clock = { now: 1_000 };
  const store = options.store ?? new EventStore(await openDatabase(":memory:"));
  const engine = new Engine({ store, now: () => clock.now });
  let projectId: string;
  let leadId: string;
  const existing = Object.values(engine.getModel().threads).find((t) => t.title === "Lead");
  if (existing !== undefined) {
    projectId = existing.projectId;
    leadId = existing.id;
    clock.now = Math.max(clock.now, ...Object.values(engine.getModel().threads).map((t) => t.updatedAt)) + 1_000;
  } else {
    const project = (await engine.dispatch({ type: "project.create", title: "P", rootPath: "/repo" })).events[0]?.event;
    if (project?.type !== "project.created") throw new Error("expected project");
    projectId = project.project.id;
    const lead = (await engine.dispatch({ type: "thread.create", projectId, provider: "claude", title: "Lead" })).events[0]?.event;
    if (lead?.type !== "thread.created") throw new Error("expected thread");
    leadId = lead.thread.id;
  }
  let n = 0;
  const tick = (): number => ++clock.now;

  const f = {
    engine,
    store,
    clock,
    projectId,
    leadId,
    model: () => engine.getModel(),
    async thread(title = "T"): Promise<string> {
      const e = (await engine.dispatch({ type: "thread.create", projectId, provider: "claude", title })).events[0]?.event;
      if (e?.type !== "thread.created") throw new Error("expected thread");
      return e.thread.id;
    },
    /** a delegate of the lead, its first turn started */
    async delegate(title: string): Promise<{ threadId: string; turnId: string }> {
      tick();
      const r = await engine.dispatch({ type: "thread.delegate", fromThreadId: leadId, provider: "claude", prompt: "do it", title });
      const created = r.events.find((x) => x.event.type === "thread.created")?.event;
      const requested = r.events.find((x) => x.event.type === "turn.requested")?.event;
      if (created?.type !== "thread.created" || requested?.type !== "turn.requested") throw new Error("expected a delegate");
      await engine.dispatch({ type: "turn.start", turnId: requested.turn.id, provider: "claude" });
      return { threadId: created.thread.id, turnId: requested.turn.id };
    },
    /** a started turn; `harness` = one Claude Code began by itself (a sub-agent reported) */
    async turn(threadId: string, opts: { harness?: string; start?: boolean } = {}): Promise<string> {
      tick();
      const r = await engine.dispatch({
        type: "turn.request",
        threadId,
        text: opts.harness ?? "go",
        ...(opts.harness !== undefined ? { notification: { source: "harness" as const, summary: opts.harness } } : {}),
      });
      const e = r.events.find((x) => x.event.type === "turn.requested")?.event;
      if (e?.type !== "turn.requested") throw new Error("expected turn");
      if (opts.start !== false) await engine.dispatch({ type: "turn.start", turnId: e.turn.id, provider: "claude" });
      return e.turn.id;
    },
    async child(threadId: string, turnId: string, key: string, status: Child["status"] = "running"): Promise<string> {
      const id = `child-${key}`;
      tick();
      await engine.dispatch({
        type: "activity.upsert",
        activity: { id, threadId, turnId, createdAt: clock.now, updatedAt: clock.now, kind: "child", childKey: key, name: key, status },
      });
      return id;
    },
    /** the sub-agent reports (inside the harness turn its report starts) */
    async report(childId: string): Promise<void> {
      const c = engine.getModel().activities[childId] as Child;
      await engine.dispatch({ type: "activity.upsert", activity: { ...c, status: "done", summary: "found it", updatedAt: tick() } });
    },
    async reply(turnId: string, text: string): Promise<void> {
      await engine.dispatch({ type: "assistant.append", turnId, messageId: `m${++n}`, delta: text });
    },
    async settle(turnId: string, status: "completed" | "error" | "interrupted" = "completed", error?: string): Promise<void> {
      tick();
      await engine.dispatch({ type: "turn.settle", turnId, status, ...(error !== undefined ? { error } : {}) });
    },
    /** the harness process is gone: its background sub-agents close without a report */
    lose: (threadId: string) => markChildrenLost(engine, threadId, { now: tick }),
  };
  return f;
}

export type BackgroundFixture = Awaited<ReturnType<typeof backgroundFixture>>;
