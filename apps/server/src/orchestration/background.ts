import { backgroundChildren, hasBackgroundChildren, type ActivityOf, type DomainEvent, type ProviderKind, type ReadModel, type Thread, type TurnStatus } from "@tide/contracts";
import { KIND_LABELS } from "../provider/registry.ts";
import type { Engine } from "./engine.ts";

type Child = ActivityOf<"child">;

/**
 * The note a lost background sub-agent is closed with. A background sub-agent lives inside the
 * harness process (Claude Code's `run_in_background` agents are in-process tasks; a `--resume`
 * of the same session id does not bring them back), so once that process is gone the report
 * can never arrive.
 */
export function lostChildSummary(harness: string): string {
  return `No report: the ${harness} session ended before this sub-agent finished`;
}

const LOST_PREFIX = "No report: ";

/** A child closed by `markChildrenLost` / `recoverLostChildren`: it ended without reporting. */
export function isLostChild(child: Child): boolean {
  return child.status === "error" && child.summary?.startsWith(LOST_PREFIX) === true;
}

function harnessOf(model: ReadModel, child: Child): string {
  const kind: ProviderKind | undefined = model.turns[child.turnId]?.provider ?? model.threads[child.threadId]?.provider;
  return kind !== undefined ? KIND_LABELS[kind] : "harness";
}

/**
 * Newest sign of life of the thread's background sub-agents: a child row or a tool row one of
 * them made (`parentToolUseId` = the child's key). undefined when nothing runs in the background.
 */
export function backgroundActivityAt(model: ReadModel, threadId: string): number | undefined {
  const children = backgroundChildren(model, threadId);
  if (children.length === 0) return undefined;
  const keys = new Set(children.map((c) => c.childKey));
  let last = Math.max(...children.map((c) => c.updatedAt));
  for (const entry of model.threadTimeline[threadId] ?? []) {
    if (entry.kind !== "activity") continue;
    const a = model.activities[entry.id];
    if (a?.kind === "tool" && a.parentToolUseId != null && keys.has(a.parentToolUseId)) last = Math.max(last, a.updatedAt);
  }
  return last;
}

/** The final rows of a thread's background sub-agents whose harness process is gone. Pure. */
export function lostChildUpserts(model: ReadModel, threadId: string, now: number): Child[] {
  return backgroundChildren(model, threadId).map((c) => ({ ...c, status: "error", summary: lostChildSummary(harnessOf(model, c)), updatedAt: now }));
}

/**
 * Closes a thread's background sub-agents as failed with no report. Call it only once the
 * harness process that ran them is gone (session closed, reaped, server restarted): while it
 * lives, a sub-agent can still report. Returns how many rows were closed.
 */
export async function markChildrenLost(
  engine: Pick<Engine, "dispatch" | "getModel">,
  threadId: string,
  options: { now?: () => number; log?: (msg: string, data?: unknown) => void } = {},
): Promise<number> {
  const now = options.now ?? (() => Date.now());
  let count = 0;
  for (const activity of lostChildUpserts(engine.getModel(), threadId, now())) {
    try {
      await engine.dispatch({ type: "activity.upsert", activity });
      count++;
    } catch (err) {
      options.log?.("[background] closing a lost sub-agent failed", err);
    }
  }
  return count;
}

const IN_FLIGHT: ReadonlySet<TurnStatus> = new Set<TurnStatus>(["queued", "requested", "running"]);

export interface ThreadQuiet {
  /** nothing left to wait for: see `threadQuiet` */
  quiescent: boolean;
  /** a turn of the thread is queued, requested or running (a harness turn included) */
  turnInFlight: boolean;
  /** sub-agents still working after the turn that launched them settled */
  background: Child[];
}

/**
 * Whether a thread is done working, as a caller waiting on it means it: its latest turn is
 * settled (or it has none), no turn is queued, requested or running, and no sub-agent works in
 * the background. A harness turn (Claude Code resuming on its own when a background sub-agent
 * reports) is covered by the same two checks: the report that opens it rides inside that turn,
 * so the child stays `running` until the turn is requested, and from then on the turn is in
 * flight. A queued turn only exists behind a running one (a settle promotes it), so the thread's
 * `running` status covers the queue. Pure.
 */
export function threadQuiet(model: ReadModel, threadId: string): ThreadQuiet {
  const thread = model.threads[threadId];
  if (thread === undefined) return { quiescent: true, turnInFlight: false, background: [] };
  const latest = thread.latestTurnId === undefined ? undefined : model.turns[thread.latestTurnId];
  const turnInFlight = thread.status === "running" || (latest !== undefined && IN_FLIGHT.has(latest.status));
  const background = backgroundChildren(model, threadId);
  return { quiescent: !turnInFlight && background.length === 0, turnInFlight, background };
}

export function isQuiescent(model: ReadModel, threadId: string): boolean {
  return threadQuiet(model, threadId).quiescent;
}

/**
 * The status an agent reads for a thread: the thread's own, except while its turn settled and
 * sub-agents still work in the background ("working (2 background sub-agents)"). `names` also
 * lists who is still working.
 */
export function agentStatus(model: ReadModel, thread: Thread, options: { names?: boolean } = {}): string {
  const quiet = threadQuiet(model, thread.id);
  if (quiet.turnInFlight || quiet.background.length === 0) return thread.status;
  const n = quiet.background.length;
  const names = options.names === true ? `: ${quiet.background.map((c) => c.name).join(", ")}` : "";
  return `working (${n} background sub-agent${n === 1 ? "" : "s"}${names})`;
}

/**
 * The thread this event left quiescent, if any: a turn settled with nothing behind it, or the
 * last background sub-agent left `running` with no turn in flight (a lost one, closed when its
 * harness process went away; a reporting one opens a harness turn first, so its settle is the
 * moment). Each quiet spell starts with exactly one such event.
 */
export function quiescedBy(model: ReadModel, event: DomainEvent): string | undefined {
  let threadId: string | undefined;
  if (event.type === "turn.settled") threadId = event.threadId;
  else if (event.type === "activity.upserted" && event.activity.kind === "child" && event.activity.status !== "running") threadId = event.activity.threadId;
  return threadId !== undefined && isQuiescent(model, threadId) ? threadId : undefined;
}

/** Whether an event can change a thread's quiescence (cheap pre-filter for subscribers). */
export function affectsQuiet(event: DomainEvent): boolean {
  if (event.type === "activity.upserted") return event.activity.kind === "child";
  return event.type.startsWith("turn.") || event.type.startsWith("thread.") || event.type.startsWith("rollback.");
}

/**
 * Sub-agents of the thread's latest round that ended without a report. A round starts at the
 * latest turn that was not a harness turn (the delegated prompt, a message sent to it).
 */
export function lostInRound(model: ReadModel, threadId: string): number {
  let since = 0;
  const ids = model.threadMessages[threadId] ?? [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const m = model.messages[ids[i] as string];
    if (m?.role !== "user" || m.notification?.source === "harness") continue;
    since = model.turns[m.turnId]?.requestedAt ?? 0;
    break;
  }
  let count = 0;
  for (const entry of model.threadTimeline[threadId] ?? []) {
    if (entry.kind !== "activity") continue;
    const a = model.activities[entry.id];
    if (a?.kind !== "child" || !isLostChild(a)) continue;
    const turn = model.turns[a.turnId];
    if (turn !== undefined && turn.rolledBack !== true && turn.requestedAt >= since) count++;
  }
  return count;
}

/** Threads with a sub-agent working in the background right now. */
export function threadsWithBackgroundChildren(model: ReadModel): string[] {
  const candidates = new Set<string>();
  for (const a of Object.values(model.activities)) if (a.kind === "child" && a.status === "running") candidates.add(a.threadId);
  return [...candidates].filter((id) => hasBackgroundChildren(model, id));
}
