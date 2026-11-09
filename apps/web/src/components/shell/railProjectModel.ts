import type { Project, Thread } from "@tide/contracts";
import type { RepoGroup } from "@tide/client";
import type { RailGroup, RailGroupKey } from "./railGroupModel.ts";

export interface RailFolder {
  /** the repo group's key (`remoteUrl` or `path:<id>`): the fold key and the React key */
  key: string;
  label: string;
  /** the group's lead project (pinned first, then oldest): menus and the icon act on it */
  project: Project;
  /** every sibling clone of the repo, across machines */
  projects: Project[];
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
 * Re-cuts `buildRailGroups`' output by project: one folder per repo group (pinned first, then
 * label); threads of every sibling clone share it. A folder with no active thread is dropped unless
 * its lead is pinned or any sibling is filtered to.
 */
export function buildRailProjectModel(groups: readonly RailGroup[], repoGroups: readonly RepoGroup[], filter: readonly string[]): RailProjectModel {
  const byKey = new Map(groups.map((g) => [g.key, g.threads]));
  const pinnedThreads: Thread[] = [];
  const keyOf = new Map<string, string>();
  for (const g of repoGroups) for (const p of g.projects) keyOf.set(p.id, g.key);
  const perFolder = new Map<string, Thread[]>();
  const needs = new Map<string, number>();
  const running = new Set<string>();
  for (const key of ACTIVE) {
    for (const t of byKey.get(key) ?? []) {
      if (t.pinned === true) {
        pinnedThreads.push(t);
        continue;
      }
      const folder = keyOf.get(t.projectId);
      if (folder === undefined) continue;
      const list = perFolder.get(folder) ?? [];
      list.push(t);
      perFolder.set(folder, list);
      if (key === "needs") needs.set(folder, (needs.get(folder) ?? 0) + 1);
      if (t.status === "running") running.add(folder);
    }
  }
  const folders: RailFolder[] = [];
  for (const g of repoGroups) {
    const threads = perFolder.get(g.key) ?? [];
    const ids = g.projects.map((p) => p.id);
    if (threads.length === 0 && g.lead.pinned !== true && !ids.some((id) => filter.includes(id))) continue;
    folders.push({
      key: g.key,
      label: g.label,
      project: g.lead,
      projects: g.projects,
      threads,
      needsCount: needs.get(g.key) ?? 0,
      running: running.has(g.key),
    });
  }
  const list = (key: RailGroupKey): Thread[] => byKey.get(key) ?? [];
  return { pinnedThreads, folders, snoozed: list("snoozed"), settled: list("settled"), archived: list("archived") };
}
