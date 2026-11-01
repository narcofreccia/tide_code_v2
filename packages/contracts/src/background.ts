import type { ActivityOf, ReadModel, TurnStatus } from "./domain.ts";

type Child = ActivityOf<"child">;

const IN_FLIGHT: ReadonlySet<TurnStatus> = new Set<TurnStatus>(["requested", "running"]);

/**
 * Background sub-agents: a thread's harness children (`kind: "child"`) still `running`
 * outside the turn in flight. Claude Code's `run_in_background` agents are the main case:
 * the turn that launched them settles and the child keeps working until it reports.
 * Shared by the server (stuck checks, auto-settle) and the client (strip, status), so both
 * agree on what "working in the background" means. Archived threads and rolled-back
 * turns have none. Order: creation time.
 */
export function backgroundChildren(model: ReadModel, threadId: string, running?: readonly Child[]): Child[] {
  const thread = model.threads[threadId];
  if (thread === undefined || thread.archivedAt !== undefined) return [];
  const candidates = running ?? Object.values(model.activities).filter((a): a is Child => a.kind === "child" && a.status === "running" && a.threadId === threadId);
  if (candidates.length === 0) return [];
  const latest = thread.latestTurnId === undefined ? undefined : model.turns[thread.latestTurnId];
  // a child of the turn in flight is foreground: the turn itself shows it live
  const activeTurnId = latest !== undefined && IN_FLIGHT.has(latest.status) ? latest.id : undefined;
  return candidates
    .filter((c) => {
      const turn = model.turns[c.turnId];
      return turn !== undefined && turn.rolledBack !== true && c.turnId !== activeTurnId;
    })
    .sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id));
}

/** True while any sub-agent of the thread works in the background. */
export function hasBackgroundChildren(model: ReadModel, threadId: string): boolean {
  return backgroundChildren(model, threadId).length > 0;
}
