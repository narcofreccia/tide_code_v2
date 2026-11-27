import { hasBackgroundChildren, type Activity, type AgentThreadSummary, type AgentTimelineItem, type Command, type ReadModel, type RpcInput, type RpcOutput, type Thread, type TimelineEntry } from "@tide/contracts";
import { clampMode } from "../orchestration/decider/agent.ts";
import { descendantsOf } from "../orchestration/decider/descendants.ts";
import { CommandError, type Engine } from "../orchestration/engine.ts";
import { affectsQuiet, agentStatus, isQuiescent } from "../orchestration/background.ts";
import { lastAssistantText, type DelegateWaits } from "../orchestration/delegation.ts";
import type { DriverRegistry } from "../provider/registry.ts";
import { instanceIdOf } from "../provider/sessions.ts";
import { readImagePaths } from "../workspace/attachments.ts";
import { pendingSecret as pendingSecretCard } from "./agentSecrets.ts";
import { RpcException, type RpcCallContext, type RpcRouter } from "./router.ts";
import { threadCwdResolver } from "./threadCwd.ts";

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
  /** R22: thread -> cwd, where `imagePaths` are read from (default: from the read model) */
  cwdFor?: (threadId: string) => string;
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

const MAX_OPEN_DELEGATES_IN_ERROR = 10;

/** Lists the caller's open delegates on a `not-found` thread id so agents self-correct in one call. */
export function notFoundThreadMessage(model: ReadModel, caller: Thread, missingId: string): string {
  const open = Object.values(model.threads)
    .filter((t) => t.delegatedBy === caller.id && t.archivedAt === undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (open.length === 0) return `unknown thread ${missingId}. You have no open delegates; call tide_thread_list to find valid ids.`;
  const shown = open.slice(0, MAX_OPEN_DELEGATES_IN_ERROR).map((t) => `${t.id} ("${t.title}", ${agentStatus(model, t)})`);
  const more = open.length > shown.length ? ` (+${open.length - shown.length} more)` : "";
  return `unknown thread ${missingId}. Your open delegates: ${shown.join(", ")}${more}`;
}

export function reachable(model: ReadModel, caller: Thread, threadId: string): Thread {
  const target = model.threads[threadId];
  if (!target) throw new RpcException("not-found", notFoundThreadMessage(model, caller, threadId));
  if (!canReach(caller, target)) throw new RpcException("forbidden", `thread ${target.id} is outside the project of ${caller.id}`);
  return target;
}

/** Driving a thread is refused when it runs with broader permissions than the caller (same ceiling as delegation). */
function requireNoBroader(caller: Thread, target: Thread): void {
  if (clampMode(target.mode, caller.mode) !== target.mode) {
    throw new RpcException("forbidden", `thread ${target.id} runs in ${target.mode}, broader than ${caller.mode}`);
  }
}

/** `status` is the thread's own, or "working (N background sub-agents)" while sub-agents outlive their turn. */
export function summarize(model: ReadModel, thread: Thread): AgentThreadSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    provider: thread.provider,
    ...(thread.model !== undefined ? { model: thread.model } : {}),
    status: agentStatus(model, thread),
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
  options: { view?: "messages" | "activity"; afterPosition?: number; limit?: number; maxCharsPerItem?: number; fromEnd?: boolean },
): { items: AgentTimelineItem[]; nextPosition: number; truncated: boolean; totalItems: number; oldestPosition?: number; hasOlder: boolean } {
  const view = options.view ?? "messages";
  const limit = options.limit ?? DEFAULT_READ_LIMIT;
  const maxChars = options.maxCharsPerItem ?? DEFAULT_MAX_CHARS;
  const timeline = model.threadTimeline[threadId] ?? [];

  if (options.fromEnd === true && options.afterPosition === undefined) {
    const matched: { position: number; item: Omit<AgentTimelineItem, "position" | "truncated"> }[] = [];
    for (let position = 0; position < timeline.length; position++) {
      const item = toItem(model, timeline[position] as TimelineEntry, view);
      if (item) matched.push({ position, item });
    }
    const totalItems = matched.length;
    const start = Math.max(0, totalItems - limit);
    const slice = matched.slice(start);
    const items: AgentTimelineItem[] = slice.map(({ position, item }) => {
      const truncated = item.text.length > maxChars;
      return { position, ...item, text: truncated ? item.text.slice(0, maxChars) : item.text, truncated };
    });
    const oldestPosition = items.length > 0 ? (items[0] as AgentTimelineItem).position : undefined;
    const nextPosition = items.length > 0 ? (items[items.length - 1] as AgentTimelineItem).position : -1;
    const hasOlder = start > 0;
    return { items, nextPosition, truncated: hasOlder, totalItems, ...(oldestPosition !== undefined ? { oldestPosition } : {}), hasOlder };
  }

  const after = options.afterPosition ?? -1;
  const items: AgentTimelineItem[] = [];
  let more = false;
  let totalItems = 0;
  for (let position = 0; position < timeline.length; position++) {
    const item = toItem(model, timeline[position] as TimelineEntry, view);
    if (!item) continue;
    totalItems++;
    if (position <= after) continue;
    if (items.length === limit) {
      more = true;
      continue;
    }
    const truncated = item.text.length > maxChars;
    items.push({ position, ...item, text: truncated ? item.text.slice(0, maxChars) : item.text, truncated });
  }
  const oldestPosition = items.length > 0 ? (items[0] as AgentTimelineItem).position : undefined;
  const nextPosition = items.length > 0 ? (items[items.length - 1] as AgentTimelineItem).position : after;
  return { items, nextPosition, truncated: more, totalItems, ...(oldestPosition !== undefined ? { oldestPosition } : {}), hasOlder: after >= 0 };
}

type WaitResult = RpcOutput<"agent.thread.wait">;

function waitResult(model: ReadModel, threadId: string, turnId: string | undefined, timedOut: boolean, low?: number): WaitResult {
  const thread = model.threads[threadId];
  const turn = turnId === undefined ? undefined : model.turns[turnId];
  const text = lastAssistantText(model, threadId);
  const settled = (turnId !== undefined && turn === undefined) || isQuiescent(model, threadId);
  return {
    status: thread !== undefined ? agentStatus(model, thread, { names: timedOut }) : "unknown",
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
 * Resolves once the thread is quiescent (see `threadQuiet`: no turn in flight, no background
 * sub-agent, so through the harness turn their report starts) and `turnId`, when given, has
 * settled; at once when it already is; when `turnId` is dequeued; or with `timedOut` after
 * `timeoutMs`. A timeout never cancels anything. When `signal` aborts (the caller stopped
 * listening) it resolves at once with the current state; the caller checks `signal.aborted`.
 */
export function waitForThread(
  engine: Engine,
  threadId: string,
  turnId: string | undefined,
  timeoutMs: number,
  schedule: (fn: () => void, ms: number) => CancelTimer = realTimer,
  grayZone?: () => { low: number; high: number },
  signal?: AbortSignal,
): Promise<WaitResult> {
  const done = (m: ReadModel): boolean => {
    if (turnId === undefined) return isQuiescent(m, threadId);
    const turn = m.turns[turnId];
    return turn === undefined || (turn.settledAt !== undefined && isQuiescent(m, threadId));
  };
  const model = engine.getModel();
  if (done(model) || signal?.aborted === true) return Promise.resolve(waitResult(model, threadId, turnId, false, grayZone?.().low));
  return new Promise((resolve) => {
    let cancel: CancelTimer | undefined;
    let finished = false;
    const off = engine.subscribe((record) => {
      if (affectsQuiet(record.event) && done(engine.getModel())) finish(false);
    });
    const onAbort = (): void => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    function finish(timedOut: boolean): void {
      if (finished) return;
      finished = true;
      off();
      cancel?.();
      signal?.removeEventListener("abort", onAbort);
      resolve(waitResult(engine.getModel(), threadId, turnId, timedOut, grayZone?.().low));
    }
    cancel = schedule(() => finish(true), timeoutMs);
  });
}

export async function dispatchThreadCommand(engine: Engine, command: Command, authorize?: (model: ReadModel) => void): Promise<Awaited<ReturnType<Engine["dispatch"]>>> {
  try {
    return await engine.dispatch(command, authorize);
  } catch (err) {
    if (err instanceof CommandError) throw new RpcException(err.code, err.message);
    throw err;
  }
}

export function listThreads(model: ReadModel, input: RpcInput<"agent.thread.list">, visible: (thread: Thread) => boolean = () => true) {
  const title = input.title?.toLowerCase();
  const threads = Object.values(model.threads)
    .filter((t) => (input.projectId === undefined || t.projectId === input.projectId) && t.archivedAt === undefined && visible(t))
    .filter((t) => input.includeDelegates === true || t.role !== "delegate")
    .filter((t) => title === undefined || t.title.toLowerCase().includes(title))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, input.limit ?? DEFAULT_LIST_LIMIT);
  return { threads: threads.map((t) => summarize(model, t)) };
}

export async function sendThreadMessage(
  { engine, registry }: Pick<AgentThreadDeps, "engine" | "registry">,
  target: Thread,
  input: RpcInput<"agent.thread.send">,
  { callerTitle, authorize, attachments }: {
    callerTitle?: string;
    authorize?: (model: ReadModel) => void;
    attachments?: () => Promise<{ images?: Awaited<ReturnType<typeof readImagePaths>> }>;
  } = {},
) {
  const mode = input.mode ?? "auto";
  const fresh = input.freshSession === true;
  if (fresh && mode === "steer") throw new RpcException("invalid-params", "freshSession starts a new turn; it cannot steer a running one");
  let steer = mode === "steer";
  // a fresh session never steers: the decider refuses it while the target runs
  if (!fresh && mode === "auto" && target.status === "running" && registry !== undefined) {
    steer = (await registry.status(instanceIdOf(target))).caps.steer === true;
  }
  const commandId = input.commandId !== undefined ? { commandId: input.commandId } : {};
  const images = attachments === undefined ? {} : await attachments();
  if (steer) {
    try {
      const result = await dispatchThreadCommand(engine, { type: "turn.steer", threadId: target.id, text: input.text, ...images, ...commandId }, authorize);
      const steered = result.events.find((r) => r.event.type === "turn.steered")?.event;
      if (steered?.type !== "turn.steered") throw new RpcException("internal", "turn.steer produced no message");
      return { turnId: steered.turnId, messageId: steered.message.id, delivered: "steered" as const };
    } catch (err) {
      // auto: the turn settled between the check and the steer, so a turn of its own starts instead
      if (mode !== "auto" || !(err instanceof RpcException) || err.code !== "conflict") throw err;
    }
  }
  const result = await dispatchThreadCommand(engine, {
    type: "turn.request",
    threadId: target.id,
    text: input.text,
    ...(callerTitle !== undefined ? { notification: { source: "system" as const, summary: `message from thread "${callerTitle}"` } } : {}),
    ...(fresh ? { freshSession: true as const } : {}),
    ...images,
    ...commandId,
  }, authorize);
  const requested = result.events.find((r) => r.event.type === "turn.requested")?.event;
  if (requested?.type !== "turn.requested") throw new RpcException("internal", "turn.request produced no turn");
  return {
    turnId: requested.turn.id,
    messageId: requested.userMessage.id,
    delivered: requested.turn.status === "queued" ? ("queued" as const) : ("started" as const),
  };
}

export async function interruptThread(engine: Engine, target: Thread) {
  if (target.status !== "running") return { ok: false };
  await dispatchThreadCommand(engine, { type: "turn.interrupt", threadId: target.id });
  return { ok: true };
}

export async function archiveThread(engine: Engine, model: ReadModel, target: Thread, input: RpcInput<"agent.thread.archive">) {
  if (target.archivedAt !== undefined) return { ok: true, archived: true, worktreeRemoved: false };
  if (target.status === "running" || hasBackgroundChildren(model, target.id)) {
    throw new RpcException("busy", `thread ${target.id} is still running`);
  }
  if (descendantsOf(model, target.id).some((d) => d.status === "running")) {
    throw new RpcException("busy", `thread ${target.id} still has a running child thread`);
  }
  if (target.attention !== undefined) {
    throw new RpcException("conflict", `thread ${target.id} is waiting for attention (${target.attention})`);
  }
  const keepWorktree = input.keepWorktree === true;
  const hadWorktree = target.worktreePath !== undefined;
  const shared =
    hadWorktree &&
    Object.values(model.threads).some(
      (t) => t.id !== target.id && t.archivedAt === undefined && t.worktreePath === target.worktreePath,
    );
  await dispatchThreadCommand(engine, {
    type: "thread.archive",
    threadId: target.id,
    ...(keepWorktree ? { keepWorktree: true } : {}),
  });
  return { ok: true, archived: true, worktreeRemoved: hadWorktree && !keepWorktree && !shared };
}

export function pendingQuestions(model: ReadModel, target: Thread) {
  const questions = (model.threadTimeline[target.id] ?? []).flatMap((entry) => {
    if (entry.kind !== "activity") return [];
    const a = model.activities[entry.id];
    // a secret card is the user's alone: no agent lists or answers it
    if (a?.kind !== "user-input" || a.status !== "pending" || a.secret === true) return [];
    return [{ requestId: a.requestId, activityId: a.id, questions: a.questions, askedAt: a.createdAt }];
  });
  return { questions };
}

export function listTasks(model: ReadModel, projectId?: string) {
  const tasks = Object.values(model.scheduledTasks)
    .filter((task) => (projectId === undefined || task.projectId === projectId) && task.archivedAt === undefined)
    .sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER));
  return { tasks };
}

export async function respondToQuestion(engine: Engine, model: ReadModel, target: Thread, input: RpcInput<"agent.pending.respond">, authorize?: (model: ReadModel) => void) {
  if (pendingSecretCard(model, target.id, input.requestId)) throw new RpcException("forbidden", "that request is a secret card only the user can answer");
  await dispatchThreadCommand(engine, { type: "user-input.respond", threadId: target.id, requestId: input.requestId, answers: input.answers }, (current) => {
    authorize?.(current);
    if (pendingSecretCard(current, target.id, input.requestId)) throw new RpcException("forbidden", "that request is a secret card only the user can answer");
  });
  return { ok: true };
}

/** R4: agents acting on other threads, under the same privilege ceiling as delegation. */
export function registerAgentThreadHandlers(router: RpcRouter, deps: AgentThreadDeps): void {
  const { engine } = deps;
  const cwdFor = deps.cwdFor ?? threadCwdResolver(engine);

  router.register("agent.thread.list", async (input, ctx) => {
    const model = engine.getModel();
    const caller = callerThread(model, ctx);
    const projectId = input.projectId ?? caller.projectId;
    return listThreads(model, { ...input, projectId }, (t) => canReach(caller, t));
  });

  router.register("agent.thread.read", async (input, ctx) => {
    const model = engine.getModel();
    const target = reachable(model, callerThread(model, ctx), input.threadId);
    return { thread: summarize(model, target), ...readTimeline(model, target.id, input) };
  });

  router.register("agent.thread.send", async (input, ctx) => {
    const model = engine.getModel();
    const caller = callerThread(model, ctx);
    const target = reachable(model, caller, input.threadId);
    requireNoBroader(caller, target);
    return sendThreadMessage(deps, target, input, {
      callerTitle: caller.title,
      attachments: async () => {
        const paths = input.imagePaths ?? [];
        return paths.length > 0 ? { images: await readImagePaths(cwdFor(caller.id), paths) } : {};
      },
    });
  });

  router.register("agent.thread.wait", async (input, ctx) => {
    const model = engine.getModel();
    const caller = callerThread(model, ctx);
    const target = reachable(model, caller, input.threadId);
    const end = deps.waits?.begin(caller.id, target.id);
    let consumed = false;
    try {
      const result = await waitForThread(engine, target.id, input.turnId, input.timeoutMs ?? DEFAULT_WAIT_MS, deps.schedule, deps.grayZone, ctx.signal);
      // The result counts as delivered when the child went quiet and the caller had not cancelled
      // or closed its socket by now. Known gap: a result written to a live socket just before the
      // caller's cancel arrives counts as delivered, and the parent gets no wake-up for it.
      consumed = !result.timedOut && !ctx.signal.aborted;
      return result;
    } finally {
      end?.(consumed);
    }
  });

  router.register("agent.thread.interrupt", async (input, ctx) => {
    const model = engine.getModel();
    const target = reachable(model, callerThread(model, ctx), input.threadId);
    return interruptThread(engine, target);
  });

  router.register("agent.thread.archive", async (input, ctx) => {
    const model = engine.getModel();
    const caller = callerThread(model, ctx);
    const target = reachable(model, caller, input.threadId);
    if (target.id === caller.id) throw new RpcException("forbidden", "a thread cannot archive itself");
    if (!descendantsOf(model, caller.id).some((d) => d.id === target.id)) {
      throw new RpcException("forbidden", `thread ${target.id} is not a child or delegate of ${caller.id}`);
    }
    requireNoBroader(caller, target);
    return archiveThread(engine, model, target, input);
  });

  router.register("agent.pending.list", async (input, ctx) => {
    const model = engine.getModel();
    const target = reachable(model, callerThread(model, ctx), input.threadId);
    return pendingQuestions(model, target);
  });

  router.register("agent.task.list", async (_input, ctx) => {
    const model = engine.getModel();
    const caller = callerThread(model, ctx);
    return listTasks(model, caller.projectId);
  });

  router.register("agent.pending.respond", async (input, ctx) => {
    const model = engine.getModel();
    const caller = callerThread(model, ctx);
    const target = reachable(model, caller, input.threadId);
    requireNoBroader(caller, target);
    return respondToQuestion(engine, model, target, input);
  });
}
