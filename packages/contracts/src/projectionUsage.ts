import type { Project, Quota, QuotaState, ReadModel, Thread, TurnUsage } from "./domain.ts";
import type { EventOf } from "./events.ts";

// Usage, limit-gauge and quota cases of the projector (R20). Same rules as projection.ts:
// pure when `mut` is false (default), in-place on top-level maps when `mut` is true during boot replay.

export type UsageEvent = EventOf<"usage.reported" | "usage.corrected" | "quota.changed" | "quota.lifted" | "quota.metered" | "turn.released">;

export interface UsageReplayState {
  queuedTurns: Set<string>;
}

function put<T>(map: Record<string, T>, key: string, value: T, mut: boolean): Record<string, T> {
  if (mut) {
    map[key] = value;
    return map;
  }
  return { ...map, [key]: value };
}

function patchModel(model: ReadModel, patch: Partial<ReadModel>, mut: boolean): ReadModel {
  if (mut) return Object.assign(model, patch);
  return { ...model, ...patch };
}

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
function withQuota(
  model: ReadModel,
  scope: "project" | "thread",
  id: string,
  change: (entity: { quota?: Quota; quotaState?: QuotaState }) => { quota?: Quota; quotaState?: QuotaState } | undefined,
  mut: boolean,
  projectAt?: number,
): ReadModel {
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
    const finalProject = projectAt !== undefined ? { ...next, updatedAt: projectAt } : next;
    return patchModel(model, { projects: put(model.projects, id, finalProject, mut) }, mut);
  }
  const thread = model.threads[id];
  const next = thread ? rebuild(thread) : undefined;
  return next ? patchModel(model, { threads: put(model.threads, id, next, mut) }, mut) : model;
}

export function applyUsageEvent(model: ReadModel, event: UsageEvent, mut = false, state?: UsageReplayState): ReadModel {
  switch (event.type) {
    case "usage.reported": {
      // every report is a delta: a turn's usage is the sum of its reports, a thread's cost the sum of its turns'
      const turn = model.turns[event.turnId];
      let next: ReadModel = model;
      if (turn && event.usage) {
        next = patchModel(next, { turns: put(next.turns, turn.id, { ...turn, usage: addUsage(turn.usage, event.usage) }, mut) }, mut);
      }
      // a report that names its window is also the instance's gauge for that window (the limit is per account, not per thread)
      if (event.rateLimit?.window !== undefined && event.providerId !== undefined) {
        if (mut) {
          next.limits ??= {};
          const byWindow = next.limits[event.providerId] ?? {};
          byWindow[event.rateLimit.window] = event.rateLimit;
          next.limits[event.providerId] = byWindow;
        } else {
          const limits = next.limits ?? {};
          next = { ...next, limits: { ...limits, [event.providerId]: { ...limits[event.providerId], [event.rateLimit.window]: event.rateLimit } } };
        }
      }
      const t = next.threads[event.threadId];
      if (!t) return next;
      const patch: Partial<Thread> = { updatedAt: event.at };
      if (event.contextUsage) patch.contextUsage = event.contextUsage;
      if (event.rateLimit) patch.rateLimit = event.rateLimit;
      if (event.usage?.costUsd !== undefined) patch.totalCostUsd = (t.totalCostUsd ?? 0) + event.usage.costUsd;
      return patchModel(next, { threads: put(next.threads, t.id, { ...t, ...patch }, mut) }, mut);
    }
    case "usage.corrected": {
      const turn = model.turns[event.turnId];
      if (!turn) return model;
      let next: ReadModel = patchModel(
        model,
        { turns: put(model.turns, turn.id, { ...turn, usage: addUsage(turn.usage, event.usage), usageCorrected: true }, mut) },
        mut,
      );
      const t = next.threads[event.threadId];
      // a float sum of deltas can land a hair under zero
      if (t && event.usage.costUsd !== undefined) {
        next = patchModel(next, { threads: put(next.threads, t.id, { ...t, totalCostUsd: Math.max(0, (t.totalCostUsd ?? 0) + event.usage.costUsd) }, mut) }, mut);
      }
      return next;
    }
    case "quota.changed":
      // the measured state belonged to the old cap: unknown until the worker meters again, so nothing is held meanwhile
      return withQuota(model, event.scope, event.id, () => (event.quota !== undefined ? { quota: event.quota } : {}), mut, event.at);
    case "quota.lifted":
      return withQuota(model, event.scope, event.id, (e) => (e.quota !== undefined && e.quotaState !== undefined ? { quota: e.quota, quotaState: { ...e.quotaState, liftedUntil: event.until } } : undefined), mut);
    case "quota.metered":
      // a measurement for a cap that was removed in the meantime is dropped
      return withQuota(model, event.scope, event.id, (e) => (e.quota !== undefined ? { quota: e.quota, quotaState: event.state } : undefined), mut);
    case "turn.released": {
      const turn = model.turns[event.turnId];
      const t = model.threads[event.threadId];
      if (!turn || !t || turn.threadId !== t.id || turn.status !== "queued" || t.status === "running") return model;
      state?.queuedTurns.delete(turn.id);
      const next: Thread = { ...t, latestTurnId: turn.id, status: "running", updatedAt: event.at };
      // like any new turn, it reopens a settled thread
      delete next.settledAt;
      delete next.settleReason;
      return patchModel(
        model,
        {
          turns: put(model.turns, turn.id, { ...turn, status: "requested" }, mut),
          threads: put(model.threads, t.id, next, mut),
        },
        mut,
      );
    }
  }
}
