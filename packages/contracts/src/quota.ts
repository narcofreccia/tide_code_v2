import type { Quota, QuotaScope, QuotaState, RateLimit, ReadModel, Thread } from "./domain.ts";

// R20: the two questions the decider, the server workers and the clients all ask about a thread,
// answered from the read model alone so they cannot disagree.

/** The registry key of the instance running a thread (the kind for its default instance). */
export function threadInstanceId(thread: Pick<Thread, "provider" | "providerId">): string {
  return thread.providerId ?? thread.provider;
}

/** The thread a lineage starts from: follows `delegatedBy` / `parentThreadId` up; a cycle or a missing parent ends the walk. */
export function rootThread(model: ReadModel, thread: Thread): Thread {
  const seen = new Set<string>();
  let current = thread;
  for (;;) {
    seen.add(current.id);
    const parentId = current.delegatedBy ?? current.parentThreadId;
    const parent = parentId !== undefined ? model.threads[parentId] : undefined;
    if (parent === undefined || seen.has(parent.id)) return current;
    current = parent;
  }
}

export interface QuotaBlock {
  scope: QuotaScope;
  id: string;
  quota: Quota;
  state: QuotaState;
}

function holds(quota: Quota | undefined, state: QuotaState | undefined, instanceId: string, now: number): boolean {
  if (quota?.onExceed !== "hold" || state?.status !== "exceeded") return false;
  if (state.liftedUntil !== undefined && state.liftedUntil > now) return false;
  // a window that has ended frees the scope without waiting for the next measurement
  if (state.windowEndsAt !== undefined && state.windowEndsAt <= now) return false;
  return state.over.includes("*") || state.over.includes(instanceId);
}

/**
 * The quota that holds new turns of `thread`, if any: its own, an ancestor's, or the project's
 * of its top-level ancestor (a delegate may sit in another project and still counts where the
 * work started). The nearest scope wins.
 */
export function quotaBlock(model: ReadModel, thread: Thread, now: number): QuotaBlock | undefined {
  const instanceId = threadInstanceId(thread);
  const seen = new Set<string>();
  let current: Thread | undefined = thread;
  let root = thread;
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    root = current;
    if (current.quota !== undefined && current.quotaState !== undefined && holds(current.quota, current.quotaState, instanceId, now)) {
      return { scope: "thread", id: current.id, quota: current.quota, state: current.quotaState };
    }
    const parentId: string | undefined = current.delegatedBy ?? current.parentThreadId;
    current = parentId !== undefined ? model.threads[parentId] : undefined;
  }
  const project = model.projects[root.projectId];
  if (project?.quota !== undefined && project.quotaState !== undefined && holds(project.quota, project.quotaState, instanceId, now)) {
    return { scope: "project", id: project.id, quota: project.quota, state: project.quotaState };
  }
  return undefined;
}

/**
 * Where a limited thread stands. `ready`: the window reopened (its reset time passed, or the
 * account answered a later request), so the thread can continue. `waiting`: a reset time is
 * known and still ahead. `unknown`: the harness gave no reset time and nothing has been heard since.
 */
export type LimitPhase = "waiting" | "ready" | "unknown";

export function limitPhase(model: ReadModel, thread: Thread, now: number): LimitPhase | undefined {
  const limited = thread.limited;
  if (limited === undefined) return undefined;
  if (limited.resetsAt !== undefined && limited.resetsAt <= now) return "ready";
  const gauges = model.limits?.[threadInstanceId(thread)];
  if (gauges !== undefined) {
    const newer = (g: RateLimit | undefined): g is RateLimit => g !== undefined && g.at > limited.at;
    if (limited.window !== undefined) {
      const gauge = gauges[limited.window];
      if (newer(gauge) && gauge.status !== "limited") return "ready";
    } else {
      // the refusing window is not known: every window heard from since must be open
      const since = Object.values(gauges).filter(newer);
      if (since.length > 0 && since.every((g) => g.status !== "limited")) return "ready";
    }
  }
  return limited.resetsAt === undefined ? "unknown" : "waiting";
}
