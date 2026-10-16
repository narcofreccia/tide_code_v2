import type { Activity, AgentThreadSummary, AgentTimelineItem, Command, ReadModel, RpcOutput, Thread, TimelineEntry } from "@tide/contracts";
import { clampMode } from "../orchestration/decider/agent.ts";
import { CommandError, type Engine } from "../orchestration/engine.ts";
import { lastAssistantText, type DelegateWaits } from "../orchestration/delegation.ts";
import type { DriverRegistry } from "../provider/registry.ts";
import { RpcException, type RpcCallContext, type RpcRouter } from "./router.ts";

export type CancelTimer = () => void;

export interface AgentThreadDeps {
  engine: Engine;
  /** driver caps decide whether `send` mode `auto` steers; without it `auto` always queues */
  registry?: Pick<DriverRegistry, "status">;
  /** timeout timer for `agent.thread.wait` (tests pass a manual clock) */
  schedule?: (fn: () => void, ms: number) => CancelTimer;
  /** marks a caller blocked on a thread, so the delegation reactor does not also wake it */
  waits?: DelegateWaits;
  /** gray zone getter: a judge verdict below `low` is left out of `agent.thread.wait` */
  grayZone?: () => { low: number; high: number };
}

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_READ_LIMIT = 50;
const DEFAULT_MAX_CHARS = 4000;
export const DEFAULT_WAIT_MS = 10 * 60_000;

const realTimer = (fn: () => void, ms: number): CancelTimer => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export function callerThread(model: ReadModel, ctx: RpcCallContext): Thread {
  const threadId = ctx.agentThreadId;
  if (threadId === undefined) throw new RpcException("forbidden", "agent methods require an agent token");
  const thread = model.threads[threadId];
  if (!thread) throw new RpcException("not-found", `unknown thread ${threadId}`);
  return thread;
}

/** An agent reaches the threads of its own project, plus the delegates it spawned (which may live in a linked repo's project). */
export function canReach(caller: Thread, target: Thread): boolean {
  return target.projectId === caller.projectId || target.delegatedBy === caller.id;
}

export function reachable(model: ReadModel, caller: Thread, threadId: string): Thread {
  const target = model.threads[threadId];
  if (!target) throw new RpcException("not-found", `unknown thread ${threadId}`);
  if (!canReach(caller, target)) throw new RpcException("forbidden", `thread ${target.id} is outside the project of ${caller.id}`);
  return target;
}

/** Driving a thread is refused when it runs with broader permissions than the caller (same ceiling as delegation). */
function requireNoBroader(caller: Thread, target: Thread): void {
  if (clampMode(target.mode, caller.mode) !== target.mode) {
    throw new RpcException("forbidden", `thread ${target.id} runs in ${target.mode}, broader than ${caller.mode}`);
  }
}

export function summarize(thread: Thread): AgentThreadSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    provider: thread.provider,
    ...(thread.model !== undefined ? { model: thread.model } : {}),
    status: thread.status,
    ...(thread.attention !== undefined ? { attention: thread.attention } : {}),
    ...(thread.role !== undefined ? { role: thread.role } : {}),
    ...(thread.delegatedBy !== undefined ? { delegatedBy: thread.delegatedBy } : {}),
    ...(thread.branch !== undefined ? { branch: thread.branch } : {}),
    worktree: thread.worktreePath !== undefined,
    limited: thread.limited !== undefined,
    updatedAt: thread.updatedAt,
  };
}

function activityItem(a: Activity): { kind: AgentTimelineItem["kind"]; text: string } {
  switch (a.kind) {
    case "tool":
      return { kind: "tool", text: `${a.toolName} (${a.status})${a.output !== undefined ? `: ${a.output}` : ""}` };
    case "approval":
      return { kind: "approval", text: `${a.title ?? a.toolName} (${a.status}${a.decision !== undefined ? `: ${a.decision}` : ""})` };
    case "user-input":
      return { kind: "question", text: a.questions.map((q) => q.text).join("\n") };
    case "child":
      return { kind: "child", text: `${a.name} (${a.status})${a.summary !== undefined ? `: ${a.summary}` : ""}` };
    default:
      return { kind: a.kind, text: a.text };
  }
}

/** One timeline entry as an agent sees it; undefined = not part of this view (or of a rolled-back turn). */
function toItem(model: ReadModel, entry: TimelineEntry, view: "messages" | "activity"): Omit<AgentTimelineItem, "position" | "truncated"> | undefined {
  if (entry.kind === "message") {
    const m = model.messages[entry.id];
    if (!m || model.turns[m.turnId]?.rolledBack === true) return undefined;
    if (m.role === "assistant" && m.text.length === 0) return undefined;
    return { turnId: m.turnId, kind: m.role, text: m.text, at: m.createdAt };
  }
  if (entry.kind === "plan") {
    const p = model.plans[entry.id];
    if (!p || model.turns[p.turnId]?.rolledBack === true) return undefined;
    return { turnId: p.turnId, kind: "plan", text: p.markdown, at: p.createdAt };
  }
  if (view !== "activity") return undefined;
  const a = model.activities[entry.id];
  if (!a || model.turns[a.turnId]?.rolledBack === true) return undefined;
  return { turnId: a.turnId, ...activityItem(a), at: a.createdAt };
}

export function readTimeline(
  model: ReadModel,
  threadId: string,
  options: { view?: "messages" | "activity"; afterPosition?: number; limit?: number; maxCharsPerItem?: number },
): { items: AgentTimelineItem[]; nextPosition: number; truncated: boolean } {
  const view = options.view ?? "messages";
  const limit = options.limit ?? DEFAULT_READ_LIMIT;
  const maxChars = options.maxCharsPerItem ?? DEFAULT_MAX_CHARS;
  const after = options.afterPosition ?? -1;
  const timeline = model.threadTimeline[threadId] ?? [];
  const items: AgentTimelineItem[] = [];
  let more = false;
  for (let position = after + 1; position < timeline.length; position++) {
    const item = toItem(model, timeline[position] as TimelineEntry, view);
    if (!item) continue;
    if (items.length === limit) {
      more = true;
      break;
    }
    const truncated = item.text.length > maxChars;
    items.push({ position, ...item, text: truncated ? item.text.slice(0, maxChars) : item.text, truncated });
  }
  const nextPosition = items.length > 0 ? (items[items.length - 1] as AgentTimelineItem).position : after;
  return { items, nextPosition, truncated: more };
}

type WaitResult = RpcOutput<"agent.thread.wait">;

function waitResult(model: ReadModel, threadId: string, turnId: string | undefined, timedOut: boolean, low?: number): WaitResult {
  const thread = model.threads[threadId];
  const turn = turnId === undefined ? undefined : model.turns[turnId];
  const text = lastAssistantText(model, threadId);
  const settled = turnId === undefined ? thread?.status !== "running" : turn === undefined || turn.settledAt !== undefined;
  return {
    status: thread?.status ?? "unknown",
    settled,
    timedOut,
    ...(thread?.attention !== undefined ? { attention: thread.attention } : {}),
    ...(text !== undefined ? { lastAssistantText: text } : {}),
    ...(turn?.error !== undefined ? { error: turn.error } : {}),
    ...(thread?.judge?.label !== undefined && low !== undefined && thread.judge.confidence >= low
      ? { judge: { label: thread.judge.label, confidence: thread.judge.confidence, source: thread.judge.source } }
      : {}),
  };
}

/**
 * Resolves when `turnId` (default: the thread's live turn) settles or is dequeued, at once when
 * nothing is in flight, or with `timedOut` after `timeoutMs`. A timeout never cancels the turn.
 */
export function waitForThread(
  engine: Engine,
  threadId: string,
  turnId: string | undefined,
  timeoutMs: number,
  schedule: (fn: () => void, ms: number) => CancelTimer = realTimer,
  grayZone?: () => { low: number; high: number },
): Promise<WaitResult> {
  const model = engine.getModel();
  const thread = model.threads[threadId];
  const target = turnId ?? (thread?.status === "running" ? thread.latestTurnId : undefined);
  const done = (m: ReadModel): boolean => target === undefined || m.turns[target] === undefined || m.turns[target]?.settledAt !== undefined;
  if (done(model)) return Promise.resolve(waitResult(model, threadId, target, false, grayZone?.().low));
  return new Promise((resolve) => {
    let cancel: CancelTimer | undefined;
    const off = engine.subscribe((record) => {
      const e = record.event;
      if ((e.type === "turn.settled" || e.type === "turn.dequeued") && e.turnId === target) finish(false);
    });
    function finish(timedOut: boolean): void {
      off();
      cancel?.();
      resolve(waitResult(engine.getModel(), threadId, target, timedOut, grayZone?.().low));
    }
    cancel = schedule(() => finish(true), timeoutMs);
  });
}

async function dispatch(engine: Engine, command: Command): Promise<Awaited<ReturnType<Engine["dispatch"]>>> {
  try {
    return await engine.dispatch(command);
  } catch (err) {
    if (err instanceof CommandError) throw new RpcException(err.code, err.message);
    throw err;
  }
}

/** R4: agents acting on other threads, under the same privilege ceiling as delegation. */
export function registerAgentThreadHandlers(router: RpcRouter, deps: AgentThreadDeps): void {
  const { engine } = deps;

  router.register("agent.thread.list", async (input, ctx) => {
    const model = engine.getModel();
    const caller = callerThread(model, ctx);
    const projectId = input.projectId ?? caller.projectId;
    const title = input.title?.toLowerCase();
    const threads = Object.values(model.threads)
      .filter((t) => t.projectId === projectId && t.archivedAt === undefined && canReach(caller, t))
      .filter((t) => input.includeDelegates === true || t.role !== "delegate")
      .filter((t) => title === undefined || t.title.toLowerCase().includes(title))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, input.limit ?? DEFAULT_LIST_LIMIT);
    return { threads: threads.map(summarize) };
  });

  router.register("agent.thread.read", async (input, ctx) => {
    const model = engine.getModel();
    const target = reachable(model, callerThread(model, ctx), input.threadId);
    return { thread: summarize(target), ...readTimeline(model, target.id, input) };
  });

  router.register("agent.thread.send", async (input, ctx) => {
    const model = engine.getModel();
    const caller = callerThread(model, ctx);
    const target = reachable(model, caller, input.threadId);
    requireNoBroader(caller, target);
    const mode = input.mode ?? "auto";
    let steer = mode === "steer";
    if (mode === "auto" && target.status === "running" && deps.registry !== undefined) {
      steer = (await deps.registry.status(target.provider)).caps.steer === true;
    }
    const commandId = input.commandId !== undefined ? { commandId: input.commandId } : {};
    if (steer) {
      try {
        const result = await dispatch(engine, { type: "turn.steer", threadId: target.id, text: input.text, ...commandId });
        const steered = result.events.find((r) => r.event.type === "turn.steered")?.event;
        if (steered?.type !== "turn.steered") throw new RpcException("internal", "turn.steer produced no message");
        return { turnId: steered.turnId, messageId: steered.message.id, delivered: "steered" as const };
      } catch (err) {
        // auto: the turn settled between the check and the steer, so a turn of its own starts instead
        if (mode !== "auto" || !(err instanceof RpcException) || err.code !== "conflict") throw err;
      }
    }
    const result = await dispatch(engine, {
      type: "turn.request",
      threadId: target.id,
      text: input.text,
      notification: { source: "system", summary: `message from thread "${caller.title}"` },
      ...commandId,
    });
    const requested = result.events.find((r) => r.event.type === "turn.requested")?.event;
    if (requested?.type !== "turn.requested") throw new RpcException("internal", "turn.request produced no turn");
    return {
      turnId: requested.turn.id,
      messageId: requested.userMessage.id,
      delivered: requested.turn.status === "queued" ? ("queued" as const) : ("started" as const),
    };
  });

  router.register("agent.thread.wait", async (input, ctx) => {
    const model = engine.getModel();
    const caller = callerThread(model, ctx);
    const target = reachable(model, caller, input.threadId);
    const end = deps.waits?.begin(caller.id, target.id);
    try {
      return await waitForThread(engine, target.id, input.turnId, input.timeoutMs ?? DEFAULT_WAIT_MS, deps.schedule, deps.grayZone);
    } finally {
      end?.();
    }
  });

  router.register("agent.thread.interrupt", async (input, ctx) => {
    const model = engine.getModel();
    const target = reachable(model, callerThread(model, ctx), input.threadId);
    if (target.status !== "running") return { ok: false };
    await dispatch(engine, { type: "turn.interrupt", threadId: target.id });
    return { ok: true };
  });

  router.register("agent.pending.list", async (input, ctx) => {
    const model = engine.getModel();
    const target = reachable(model, callerThread(model, ctx), input.threadId);
    const questions = (model.threadTimeline[target.id] ?? []).flatMap((entry) => {
      if (entry.kind !== "activity") return [];
      const a = model.activities[entry.id];
      if (a?.kind !== "user-input" || a.status !== "pending") return [];
      return [{ requestId: a.requestId, activityId: a.id, questions: a.questions, askedAt: a.createdAt }];
    });
    return { questions };
  });

  router.register("agent.task.list", async (_input, ctx) => {
    const model = engine.getModel();
    const caller = callerThread(model, ctx);
    const tasks = Object.values(model.scheduledTasks)
      .filter((task) => task.projectId === caller.projectId && task.archivedAt === undefined)
      .sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER));
    return { tasks };
  });

  router.register("agent.pending.respond", async (input, ctx) => {
    const model = engine.getModel();
    const caller = callerThread(model, ctx);
    const target = reachable(model, caller, input.threadId);
    requireNoBroader(caller, target);
    await dispatch(engine, { type: "user-input.respond", threadId: target.id, requestId: input.requestId, answers: input.answers });
    return { ok: true };
  });
}
