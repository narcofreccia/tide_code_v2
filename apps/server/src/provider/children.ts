import type { DriverActivity, ReadModel } from "@tide/contracts";

/** The row a sub-agent was launched on and the turn it belongs to. */
export interface ChildRow {
  id: string;
  turnId: string;
}

/** Alias under which a child row is also indexed by the harness's own task id. */
const taskAlias = (taskId: string): string => `task:${taskId}`;

/**
 * The child row a driver key (`childKey`, or a tool's `parentToolUseId`) and optional
 * harness task id belong to. The in-memory map is the fast path; after a server restart (or a
 * driver whose normalizer was rebuilt) it is empty, so the thread's timeline is walked
 * backwards for a `child` activity with the same key or task id. A hit is cached.
 */
export function findChildRow(children: Map<string, ChildRow>, model: ReadModel, threadId: string, key: string, taskId: string | undefined): ChildRow | undefined {
  const cached = children.get(key) ?? (taskId !== undefined ? children.get(taskAlias(taskId)) : undefined);
  if (cached !== undefined) return cached;
  const timeline = model.threadTimeline[threadId] ?? [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    if (entry?.kind !== "activity") continue;
    const activity = model.activities[entry.id];
    if (activity?.kind !== "child") continue;
    if (activity.childKey !== key && (taskId === undefined || activity.taskId !== taskId)) continue;
    const row = { id: activity.id, turnId: activity.turnId };
    rememberChild(children, activity.childKey, activity.taskId, row);
    if (activity.childKey !== key) children.set(key, row);
    return row;
  }
  return undefined;
}

/** Records a child row under its key and, when known, its task id. */
export function rememberChild(children: Map<string, ChildRow>, key: string, taskId: string | undefined, row: ChildRow): void {
  children.set(key, row);
  if (taskId !== undefined) children.set(taskAlias(taskId), row);
}

/** The sub-agent row an activity belongs to: a child's own row, or the child a tool runs under. */
export function ownerChildRow(children: Map<string, ChildRow>, model: ReadModel, threadId: string, activity: DriverActivity): ChildRow | undefined {
  if (activity.kind === "child") return findChildRow(children, model, threadId, activity.childKey, activity.taskId);
  return activity.parentToolUseId ? findChildRow(children, model, threadId, activity.parentToolUseId, undefined) : undefined;
}
