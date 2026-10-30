import { compareByAttention, selectExpertsSessions, selectInbox, selectRailGroups } from "@tide/client";
import type { ExpertsSession, ReadModel, Thread } from "@tide/contracts";
import { sessionThreadIds } from "./ExpertsGroup.tsx";

/** The rail's groups, top to bottom. Projects are a filter over them, never a tree. */
export const RAIL_GROUP_KEYS = ["needs", "inbox", "working", "snoozed", "settled", "archived"] as const;
export type RailGroupKey = (typeof RAIL_GROUP_KEYS)[number];

export const RAIL_GROUP_LABELS: Record<RailGroupKey, string> = {
  needs: "Needs you",
  inbox: "Inbox",
  working: "Working",
  snoozed: "Snoozed",
  settled: "Settled",
  archived: "Archived",
};

/** Settled and Archived start folded; the user's choice then sticks (see railGroupState). */
export const COLLAPSED_BY_DEFAULT: ReadonlySet<RailGroupKey> = new Set(["settled", "archived"]);

export interface RailGroup {
  key: RailGroupKey;
  /** every thread of the group, before nesting: what the count says */
  threads: Thread[];
  /** Experts sessions whose lead sits in this group, rendered with their threads nested */
  sessions: ExpertsSession[];
}

const bySettledDesc = (a: Thread, b: Thread): number => (b.settledAt ?? 0) - (a.settledAt ?? 0) || a.id.localeCompare(b.id);

/**
 * Merges `selectRailGroups` over the projects in scope. Needs you is pulled out of
 * the inbox (and Working) so a waiting thread is listed once; pinned threads lead
 * the inbox. A session lands in its lead's group (else its first expert's, else Inbox).
 */
export function buildRailGroups(
  model: ReadModel,
  projectIds: readonly string[],
  now: number,
  opts: { workingSection?: boolean } = {},
): RailGroup[] {
  const scope = new Set(projectIds);
  const needsIds = new Set<string>();
  const needs: Thread[] = [];
  for (const item of selectInbox(model)) {
    if (!scope.has(item.thread.projectId) || needsIds.has(item.thread.id)) continue;
    needsIds.add(item.thread.id);
    needs.push(item.thread);
  }
  const pinned: Thread[] = [];
  const loose: Thread[] = [];
  const working: Thread[] = [];
  const snoozed: Thread[] = [];
  const settled: Thread[] = [];
  const archived: Thread[] = [];
  for (const projectId of projectIds) {
    const g = selectRailGroups(model, projectId, now, opts);
    pinned.push(...g.pinned.filter((t) => !needsIds.has(t.id)));
    loose.push(...g.threads.filter((t) => !needsIds.has(t.id)));
    working.push(...g.working.filter((t) => !needsIds.has(t.id)));
    snoozed.push(...g.snoozed);
    settled.push(...g.settled);
    archived.push(...g.archived);
  }
  const lists: Record<RailGroupKey, Thread[]> = {
    needs,
    inbox: [...pinned.sort(compareByAttention), ...loose.sort(compareByAttention)],
    working: working.sort(compareByAttention),
    snoozed: snoozed.sort(compareByAttention),
    settled: settled.sort(bySettledDesc),
    archived: archived.sort(compareByAttention),
  };

  const groupOf = new Map<string, RailGroupKey>();
  for (const key of RAIL_GROUP_KEYS) for (const t of lists[key]) groupOf.set(t.id, key);
  const sessions: Record<RailGroupKey, ExpertsSession[]> = { needs: [], inbox: [], working: [], snoozed: [], settled: [], archived: [] };
  for (const projectId of projectIds) {
    for (const session of selectExpertsSessions(model, projectId)) {
      const home = sessionThreadIds(session).map((id) => groupOf.get(id)).find((k) => k !== undefined);
      // a session whose threads are all archived stays out of the live groups
      if (home === "archived") continue;
      sessions[home ?? "inbox"].push(session);
    }
  }

  return RAIL_GROUP_KEYS.map((key) => ({ key, threads: lists[key], sessions: sessions[key] }));
}

/** Threads a listed session already shows: they are not repeated loose in its group. */
export function claimedBy(sessions: readonly ExpertsSession[]): Set<string> {
  return new Set(sessions.flatMap(sessionThreadIds));
}
