import { isListedThread, isSettled, isSnoozed } from "@tide/client";
import type { ReadModel, Thread } from "@tide/contracts";
import { threadRecency } from "../../lib/threadRecency.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { parentOf } from "./railTree.ts";

function compareLatest(a: Thread, b: Thread, recency: Record<string, number>): number {
  const aAt = Math.max(a.updatedAt, a.settledAt ?? 0, recency[a.id] ?? 0);
  const bAt = Math.max(b.updatedAt, b.settledAt ?? 0, recency[b.id] ?? 0);
  return bAt - aAt || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

function preferRoots(threads: readonly Thread[]): Thread[] {
  const ids = new Set(threads.map((t) => t.id));
  const roots = threads.filter((t) => {
    const parent = parentOf(t);
    return parent === undefined || !ids.has(parent);
  });
  return roots.length > 0 ? roots : [...threads];
}

/**
 * Picks the thread to bring into view when a user selects one or more projects:
 *  1. Latest active (non-archived, non-settled, non-snoozed) thread, preferring root threads over nested delegates.
 *  2. Fallback to the latest snoozed/settled non-archived thread in the project.
 *  3. Undefined when the project has no non-archived threads.
 */
export function latestThreadForProjects(
  model: ReadModel,
  projectIds: readonly string[],
  now: number = Date.now(),
  recency: Record<string, number> = threadRecency(),
): Thread | undefined {
  if (projectIds.length === 0) return undefined;
  const scope = new Set(projectIds);
  const live = Object.values(model.threads).filter(
    (t) => scope.has(t.projectId) && t.archivedAt === undefined && isListedThread(t),
  );
  if (live.length === 0) return undefined;
  const active = live.filter((t) => !isSettled(t) && !isSnoozed(t, now));
  const pool = active.length > 0 ? preferRoots(active) : preferRoots(live);
  return pool.sort((a, b) => compareLatest(a, b, recency))[0];
}

/**
 * Scopes the rail to `projectIds` and brings that project's latest active thread into view,
 * unless the user is already viewing a live thread belonging to those projects. When the
 * chosen project has no non-archived threads and the open thread belongs to another project,
 * clears the stale thread so the main view never misleads the user about which project is open.
 */
export function selectProjectScope(projectIds: readonly string[]): void {
  const ui = useUi.getState();
  ui.selectProjects([...projectIds]);
  if (projectIds.length === 0) return;
  const model = useModel.getState().model;
  const current = ui.selectedThreadId === null ? undefined : model.threads[ui.selectedThreadId];
  if (ui.view === "thread" && current !== undefined && current.archivedAt === undefined && projectIds.includes(current.projectId)) {
    return;
  }
  const latest = latestThreadForProjects(model, projectIds);
  if (latest !== undefined) {
    ui.selectThread(latest.id);
    return;
  }
  if (current !== undefined && !projectIds.includes(current.projectId)) {
    ui.selectThread(null);
  }
}
