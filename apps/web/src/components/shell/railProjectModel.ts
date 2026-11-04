import type { Project, Thread } from "@tide/contracts";
import { pinnedFirst } from "../../lib/projectActions.ts";
import type { RailGroup, RailGroupKey } from "./railGroupModel.ts";

export interface RailFolder {
  project: Project;
  /** needs → inbox → working, in group order */
  threads: Thread[];
  needsCount: number;
  running: boolean;
}

export interface RailProjectModel {
  /** pinned threads that are active, lifted above the folders */
  pinnedThreads: Thread[];
  folders: RailFolder[];
  snoozed: Thread[];
  settled: Thread[];
  archived: Thread[];
}

const ACTIVE: readonly RailGroupKey[] = ["needs", "inbox", "working"];

/**
 * Re-cuts `buildRailGroups`' output by project: one folder per project (pinned first, then
 * title). A folder with no active thread is dropped unless its project is pinned or filtered to.
 */
export function buildRailProjectModel(groups: readonly RailGroup[], projects: readonly Project[], filter: readonly string[]): RailProjectModel {
  const byKey = new Map(groups.map((g) => [g.key, g.threads]));
  const pinnedThreads: Thread[] = [];
  const perProject = new Map<string, Thread[]>();
  const needs = new Map<string, number>();
  const running = new Set<string>();
  for (const key of ACTIVE) {
    for (const t of byKey.get(key) ?? []) {
      if (t.pinned === true) {
        pinnedThreads.push(t);
        continue;
      }
      const list = perProject.get(t.projectId) ?? [];
      list.push(t);
      perProject.set(t.projectId, list);
      if (key === "needs") needs.set(t.projectId, (needs.get(t.projectId) ?? 0) + 1);
      if (t.status === "running") running.add(t.projectId);
    }
  }
  const folders: RailFolder[] = [];
  for (const project of pinnedFirst(projects)) {
    const threads = perProject.get(project.id) ?? [];
    if (threads.length === 0 && project.pinned !== true && !filter.includes(project.id)) continue;
    folders.push({ project, threads, needsCount: needs.get(project.id) ?? 0, running: running.has(project.id) });
  }
  const list = (key: RailGroupKey): Thread[] => byKey.get(key) ?? [];
  return { pinnedThreads, folders, snoozed: list("snoozed"), settled: list("settled"), archived: list("archived") };
}
