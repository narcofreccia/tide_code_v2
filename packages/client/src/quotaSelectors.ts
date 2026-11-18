import {
  quotaBlock,
  type Project,
  type Quota,
  type QuotaScope,
  type QuotaState,
  type ReadModel,
  type Thread,
} from "@tide/contracts";

// R20: usage quotas as the web shows them. The server measures (`quota.meter`), the
// decider holds (`quotaBlock`); these only phrase what the read model already says.

export type QuotaStatus = "measuring" | QuotaState["status"];

/** One scope's quota, ready to render. */
export interface QuotaView {
  scope: QuotaScope;
  id: string;
  /** the project's or thread's title */
  title: string;
  quota: Quota;
  /** `measuring` right after `quota.set`, until the server measures again */
  status: QuotaStatus;
  /** share of the cap used, 100 = at the cap; undefined while measuring */
  usedPct?: number;
  /** `cap 30% of the weekly window`, `cap $20.00 a week`, or both */
  capText: string;
  /** `≈ 12% of the weekly window, cap 30%` / `≈ $11.00 of $20.00 this week`; undefined while measuring */
  figureText?: string;
  /** new turns in this scope wait right now: hold policy, exceeded, window not ended, no lift */
  holding: boolean;
  /** when the measured window ends (the hold then frees itself) */
  resetsAt?: number;
  /** an active lift: the hold is off until then */
  liftedUntil?: number;
  /** the figure includes spend Tide cannot see or an estimated price */
  approx: boolean;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function round(value: number): number {
  return Math.round(value);
}

/** `cap 30% of the weekly window, $20.00 a week`. */
export function quotaCapText(quota: Quota): string {
  const parts: string[] = [];
  if (quota.sharePct !== undefined) parts.push(`${round(quota.sharePct)}% of the weekly window`);
  if (quota.usdPerWeek !== undefined) parts.push(`${usd(quota.usdPerWeek)} a week`);
  return parts.length === 0 ? "no cap" : `cap ${parts.join(", ")}`;
}

/** What `usedPct` of the cap stands for, in the cap's own unit. */
export function quotaFigureText(quota: Quota, state: QuotaState): string {
  const used = state.usedPct / 100;
  if (state.basis === "share" && quota.sharePct !== undefined) {
    return `≈ ${round(used * quota.sharePct)}% of the weekly window, cap ${round(quota.sharePct)}%`;
  }
  if (state.basis === "usd" && quota.usdPerWeek !== undefined) {
    return `≈ ${usd(used * quota.usdPerWeek)} of ${usd(quota.usdPerWeek)} this week`;
  }
  return `≈ ${round(state.usedPct)}% of the quota`;
}

function stateHolds(quota: Quota, state: QuotaState, now: number): boolean {
  if (quota.onExceed !== "hold" || state.status !== "exceeded") return false;
  if (state.liftedUntil !== undefined && state.liftedUntil > now) return false;
  return state.windowEndsAt === undefined || state.windowEndsAt > now;
}

/** The view of a project's or thread's quota; undefined when it has none. */
export function quotaView(
  scope: QuotaScope,
  entity: Pick<Project | Thread, "id" | "title" | "quota" | "quotaState">,
  now: number = Date.now(),
): QuotaView | undefined {
  const quota = entity.quota;
  if (quota === undefined) return undefined;
  const state = entity.quotaState;
  const base = { scope, id: entity.id, title: entity.title, quota, capText: quotaCapText(quota) };
  if (state === undefined) return { ...base, status: "measuring", holding: false, approx: false };
  const lifted = state.liftedUntil !== undefined && state.liftedUntil > now;
  return {
    ...base,
    status: state.status,
    usedPct: state.usedPct,
    figureText: quotaFigureText(quota, state),
    holding: stateHolds(quota, state, now),
    ...(state.windowEndsAt === undefined ? {} : { resetsAt: state.windowEndsAt }),
    ...(lifted && state.liftedUntil !== undefined ? { liftedUntil: state.liftedUntil } : {}),
    approx: state.approx === true,
  };
}

export function selectProjectQuota(model: ReadModel, projectId: string, now: number = Date.now()): QuotaView | undefined {
  const project = model.projects[projectId];
  return project === undefined ? undefined : quotaView("project", project, now);
}

export function selectThreadQuota(model: ReadModel, threadId: string, now: number = Date.now()): QuotaView | undefined {
  const thread = model.threads[threadId];
  return thread === undefined ? undefined : quotaView("thread", thread, now);
}

/** The quota holding new turns of a thread (its own, an ancestor's, its project's), as a view. */
export function selectQuotaHold(model: ReadModel, thread: Thread, now: number = Date.now()): QuotaView | undefined {
  const block = quotaBlock(model, thread, now);
  if (block === undefined) return undefined;
  const entity = block.scope === "project" ? model.projects[block.id] : model.threads[block.id];
  return entity === undefined ? undefined : quotaView(block.scope, entity, now);
}

/** `Project quota reached (≈ 31% of the weekly window, cap 30%)`. */
export function quotaHoldText(view: QuotaView): string {
  const what = view.scope === "project" ? "Project quota reached" : "Thread quota reached";
  return view.figureText === undefined ? what : `${what} (${view.figureText})`;
}

/** A project whose quota holds new turns, with the live threads it holds. */
export interface HeldProject {
  view: QuotaView;
  threads: Thread[];
}

/** Projects whose quota holds right now, optionally limited to some ids; by title. */
export function selectHeldProjects(model: ReadModel, projectIds?: readonly string[], now: number = Date.now()): HeldProject[] {
  const scope = projectIds === undefined ? undefined : new Set(projectIds);
  const held = new Map<string, HeldProject>();
  for (const project of Object.values(model.projects)) {
    if (project.archivedAt !== undefined || (scope !== undefined && !scope.has(project.id))) continue;
    const view = quotaView("project", project, now);
    if (view?.holding === true) held.set(project.id, { view, threads: [] });
  }
  if (held.size === 0) return [];
  for (const thread of Object.values(model.threads)) {
    if (thread.archivedAt !== undefined) continue;
    const block = quotaBlock(model, thread, now);
    if (block?.scope === "project") held.get(block.id)?.threads.push(thread);
  }
  return [...held.values()].sort((a, b) => a.view.title.localeCompare(b.view.title) || a.view.id.localeCompare(b.view.id));
}

/**
 * Why an idle thread's queued turns are not running: the thread waits on its harness limit,
 * or a quota holds it. Undefined while a turn runs (the queue is just waiting its turn).
 */
export function queueHoldText(model: ReadModel, thread: Thread, now: number = Date.now()): string | undefined {
  if (thread.status === "running") return undefined;
  if (thread.limited !== undefined) return "Held until the limit resets";
  return quotaBlock(model, thread, now) === undefined ? undefined : "Held by quota";
}
