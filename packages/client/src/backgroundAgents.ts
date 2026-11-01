import { backgroundChildren, type ActivityOf, type ReadModel } from "@tide/contracts";
import { displayToolName, shortTarget } from "./toolTarget.ts";

/*
 * Background sub-agents: harness children (`kind: "child"`) still `running` outside the
 * turn in flight. Claude Code's `run_in_background` agents are the main case: the turn
 * that launched them settles, the thread reads idle, and the child keeps streaming its
 * own tool rows onto that turn until it reports. Harness-agnostic: it reads normalized
 * child activities only, so any driver's children are covered.
 *
 * Never invents "done": a silent child stays listed with an honest `quietMs`. When its
 * harness session ends, the server closes it as `error` ("No report: …") and it drops out.
 */

/** The newest tool call a background agent made. */
export interface BackgroundAgentStep {
  /** display name, `Read` / `Bash` / `Search` */
  toolName: string;
  /** short target, `skills.py` / `pnpm test` */
  target?: string;
  at: number;
}

export interface BackgroundAgentCore {
  /** the child activity's id */
  activityId: string;
  childKey: string;
  threadId: string;
  /** the turn that launched it (where its group lives in the transcript) */
  turnId: string;
  name: string;
  description?: string;
  startedAt: number;
  /** the newest tool row under it, if any */
  last?: BackgroundAgentStep;
  /** newest sign of life: the child row itself or one of its tool rows */
  lastActivityAt: number;
  /** tool calls made under this child so far */
  toolCalls: number;
}

export interface BackgroundAgent extends BackgroundAgentCore {
  /** now − lastActivityAt, never negative */
  quietMs: number;
}

type Child = ActivityOf<"child">;
type Tool = ActivityOf<"tool">;

interface ToolStats {
  count: number;
  newest: Tool | undefined;
}

interface Index {
  /** threadId -> its running children, in creation order */
  running: Map<string, Child[]>;
  /** `${threadId}\0${childKey}` -> tool rows under that running child */
  tools: Map<string, ToolStats>;
}

const toolKey = (threadId: string, childKey: string): string => `${threadId}\u0000${childKey}`;

/** One pass over the activities map per map identity (the projector replaces it only on a change). */
const indexOf = new WeakMap<ReadModel["activities"], Index>();

function indexActivities(activities: ReadModel["activities"]): Index {
  let index = indexOf.get(activities);
  if (index !== undefined) return index;
  const running = new Map<string, Child[]>();
  const tools = new Map<string, ToolStats>();
  const all = Object.values(activities);
  for (const a of all) {
    if (a.kind !== "child" || a.status !== "running") continue;
    const list = running.get(a.threadId);
    if (list) list.push(a);
    else running.set(a.threadId, [a]);
    tools.set(toolKey(a.threadId, a.childKey), { count: 0, newest: undefined });
  }
  if (tools.size > 0) {
    for (const a of all) {
      if (a.kind !== "tool" || a.parentToolUseId === undefined) continue;
      const stats = tools.get(toolKey(a.threadId, a.parentToolUseId));
      if (stats === undefined) continue;
      stats.count += 1;
      if (stats.newest === undefined || a.updatedAt >= stats.newest.updatedAt) stats.newest = a;
    }
  }
  index = { running, tools };
  indexOf.set(activities, index);
  return index;
}

/** The running children of `threadId` that count as background (rule shared with the server). */
function backgroundChildrenOf(model: ReadModel, threadId: string): Child[] {
  const children = indexActivities(model.activities).running.get(threadId);
  return children === undefined ? [] : backgroundChildren(model, threadId, children);
}

/** How many sub-agents of the thread work in the background. Cheap: one shared index per activities map. */
export function countBackgroundAgents(model: ReadModel, threadId: string): number {
  return backgroundChildrenOf(model, threadId).length;
}

function coreOf(child: Child, index: Index): BackgroundAgentCore {
  const stats = index.tools.get(toolKey(child.threadId, child.childKey));
  const newest = stats?.newest;
  let last: BackgroundAgentStep | undefined;
  if (newest !== undefined) {
    const target = shortTarget(newest.input);
    last = { toolName: displayToolName(newest.toolName), ...(target === undefined ? {} : { target }), at: newest.updatedAt };
  }
  return {
    activityId: child.id,
    childKey: child.childKey,
    threadId: child.threadId,
    turnId: child.turnId,
    name: child.name,
    ...(child.description === undefined ? {} : { description: child.description }),
    startedAt: child.createdAt,
    ...(last === undefined ? {} : { last }),
    lastActivityAt: Math.max(child.updatedAt, newest?.updatedAt ?? 0),
    toolCalls: stats?.count ?? 0,
  };
}

function sameCore(a: BackgroundAgentCore, b: BackgroundAgentCore): boolean {
  return (
    a.activityId === b.activityId &&
    a.childKey === b.childKey &&
    a.turnId === b.turnId &&
    a.name === b.name &&
    a.description === b.description &&
    a.startedAt === b.startedAt &&
    a.lastActivityAt === b.lastActivityAt &&
    a.toolCalls === b.toolCalls &&
    a.last?.toolName === b.last?.toolName &&
    a.last?.target === b.last?.target &&
    a.last?.at === b.last?.at
  );
}

interface CoreMemo {
  activities: ReadModel["activities"];
  turns: ReadModel["turns"];
  threads: ReadModel["threads"];
  list: BackgroundAgentCore[];
}
const lastCore = new Map<string, CoreMemo>();
const EMPTY: BackgroundAgentCore[] = [];

/**
 * The thread's background agents without the clock: the same array (and items) until
 * one of them changes — a streaming delta, another thread's rows or an unrelated turn
 * hand back the previous result.
 */
export function selectBackgroundAgentsCore(model: ReadModel, threadId: string): BackgroundAgentCore[] {
  const prev = lastCore.get(threadId);
  if (prev !== undefined && prev.activities === model.activities && prev.turns === model.turns && prev.threads === model.threads) return prev.list;
  const index = indexActivities(model.activities);
  const fresh = backgroundChildrenOf(model, threadId).map((c) => coreOf(c, index));
  let list: BackgroundAgentCore[];
  if (fresh.length === 0) list = EMPTY;
  else if (prev !== undefined && prev.list.length === fresh.length && fresh.every((c, i) => sameCore(c, prev.list[i] as BackgroundAgentCore))) list = prev.list;
  else {
    const before = new Map((prev?.list ?? []).map((c) => [c.activityId, c] as const));
    list = fresh.map((c) => {
      const old = before.get(c.activityId);
      return old !== undefined && sameCore(old, c) ? old : c;
    });
  }
  lastCore.set(threadId, { activities: model.activities, turns: model.turns, threads: model.threads, list });
  return list;
}

const lastTimed = new Map<string, { core: BackgroundAgentCore[]; now: number; list: BackgroundAgent[] }>();
const NONE: BackgroundAgent[] = [];

/**
 * The thread's sub-agents still running outside the turn in flight (all of them while the
 * thread is idle), oldest first, each with what it did last and how long it has been quiet.
 * Stable: the same array for the same agents and the same `now`, so it is safe as a store selector.
 */
export function selectBackgroundAgents(model: ReadModel, threadId: string, now: number): BackgroundAgent[] {
  const core = selectBackgroundAgentsCore(model, threadId);
  if (core.length === 0) return NONE;
  const prev = lastTimed.get(threadId);
  if (prev !== undefined && prev.core === core && prev.now === now) return prev.list;
  const list = core.map((c) => ({ ...c, quietMs: Math.max(0, now - c.lastActivityAt) }));
  lastTimed.set(threadId, { core, now, list });
  return list;
}

/** Past this a background agent reads "quiet for 12m" instead of what it did last. */
export const BACKGROUND_QUIET_MS = 5 * 60_000;
