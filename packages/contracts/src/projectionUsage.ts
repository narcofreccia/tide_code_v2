import type { Project, Quota, QuotaState, ReadModel, Thread, TurnUsage } from "./domain.ts";
import type { EventOf } from "./events.ts";

// Usage, limit-gauge and quota cases of the projector (R20). Same rules as projection.ts:
// pure, never mutates its input.

export type UsageEvent = EventOf<"usage.reported" | "usage.corrected" | "quota.changed" | "quota.lifted" | "quota.metered" | "turn.released">;

export function addUsage(prev: TurnUsage | undefined, delta: TurnUsage): TurnUsage {
  if (!prev) return delta;
  const sum = (a?: number, b?: number): number | undefined => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  const out: TurnUsage = { inputTokens: prev.inputTokens + delta.inputTokens, outputTokens: prev.outputTokens + delta.outputTokens };
  const cr = sum(prev.cacheReadTokens, delta.cacheReadTokens);
  const cw = sum(prev.cacheWriteTokens, delta.cacheWriteTokens);
  const cost = sum(prev.costUsd, delta.costUsd);
  if (cr !== undefined) out.cacheReadTokens = cr;
  if (cw !== undefined) out.cacheWriteTokens = cw;
  if (cost !== undefined) out.costUsd = cost;
  return out;
}

/** Sets or clears `quota` / `quotaState` on the project or thread a quota event names. */
function withQuota(model: ReadModel, scope: "project" | "thread", id: string, change: (entity: { quota?: Quota; quotaState?: QuotaState }) => { quota?: Quota; quotaState?: QuotaState } | undefined, projectAt?: number): ReadModel {
  const rebuild = <T extends Project | Thread>(entity: T): T | undefined => {
    const changed = change(entity);
    if (changed === undefined) return undefined;
    const next: T = { ...entity };
    delete next.quota;
    delete next.quotaState;
    if (changed.quota !== undefined) next.quota = changed.quota;
    if (changed.quotaState !== undefined) next.quotaState = changed.quotaState;
    return next;
  };
  if (scope === "project") {
    const project = model.projects[id];
    const next = project ? rebuild(project) : undefined;
    if (!next) return model;
    return { ...model, projects: { ...model.projects, [id]: projectAt !== undefined ? { ...next, updatedAt: projectAt } : next } };
  }
  const thread = model.threads[id];
  const next = thread ? rebuild(thread) : undefined;
  return next ? { ...model, threads: { ...model.threads, [id]: next } } : model;
}

export function applyUsageEvent(model: ReadModel, event: UsageEvent): ReadModel {
  switch (event.type) {
    case "usage.reported": {
      // every report is a delta: a turn's usage is the sum of its reports, a thread's cost the sum of its turns'
      const turn = model.turns[event.turnId];
      let next: ReadModel = model;
      if (turn && event.usage) next = { ...next, turns: { ...next.turns, [turn.id]: { ...turn, usage: addUsage(turn.usage, event.usage) } } };
      // a report that names its window is also the instance's gauge for that window (the limit is per account, not per thread)
      if (event.rateLimit?.window !== undefined && event.providerId !== undefined) {
        const limits = next.limits ?? {};
        next = { ...next, limits: { ...limits, [event.providerId]: { ...limits[event.providerId], [event.rateLimit.window]: event.rateLimit } } };
      }
      const t = next.threads[event.threadId];
      if (!t) return next;
      const patch: Partial<Thread> = { updatedAt: event.at };
      if (event.contextUsage) patch.contextUsage = event.contextUsage;
      if (event.rateLimit) patch.rateLimit = event.rateLimit;
      if (event.usage?.costUsd !== undefined) patch.totalCostUsd = (t.totalCostUsd ?? 0) + event.usage.costUsd;
      return { ...next, threads: { ...next.threads, [t.id]: { ...t, ...patch } } };
    }
    case "usage.corrected": {
      const turn = model.turns[event.turnId];
      if (!turn) return model;
      let next: ReadModel = { ...model, turns: { ...model.turns, [turn.id]: { ...turn, usage: addUsage(turn.usage, event.usage), usageCorrected: true } } };
      const t = next.threads[event.threadId];
      // a float sum of deltas can land a hair under zero
      if (t && event.usage.costUsd !== undefined) next = { ...next, threads: { ...next.threads, [t.id]: { ...t, totalCostUsd: Math.max(0, (t.totalCostUsd ?? 0) + event.usage.costUsd) } } };
      return next;
    }
    case "quota.changed":
      // the measured state belonged to the old cap: unknown until the worker meters again, so nothing is held meanwhile
      return withQuota(model, event.scope, event.id, () => (event.quota !== undefined ? { quota: event.quota } : {}), event.at);
    case "quota.lifted":
      return withQuota(model, event.scope, event.id, (e) => (e.quota !== undefined && e.quotaState !== undefined ? { quota: e.quota, quotaState: { ...e.quotaState, liftedUntil: event.until } } : undefined));
    case "quota.metered":
      // a measurement for a cap that was removed in the meantime is dropped
      return withQuota(model, event.scope, event.id, (e) => (e.quota !== undefined ? { quota: e.quota, quotaState: event.state } : undefined));
    case "turn.released": {
      const turn = model.turns[event.turnId];
      const t = model.threads[event.threadId];
      if (!turn || !t || turn.threadId !== t.id || turn.status !== "queued" || t.status === "running") return model;
      const next: Thread = { ...t, latestTurnId: turn.id, status: "running", updatedAt: event.at };
      // like any new turn, it reopens a settled thread
      delete next.settledAt;
      delete next.settleReason;
      return { ...model, turns: { ...model.turns, [turn.id]: { ...turn, status: "requested" } }, threads: { ...model.threads, [t.id]: next } };
    }
  }
}
