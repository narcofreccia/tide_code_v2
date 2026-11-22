import { useMemo, useRef } from "react";
import { compareByAttention } from "@tide/client";
import type { ReadModel, Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { sessionThreadIds } from "./ExpertsGroup.tsx";
import { buildRailGroups, claimedBy, railNeedsOrder, type RailGroup } from "./railGroupModel.ts";
import { RailTreeBuilder, childrenIndex, parentOf, type RailNode } from "./railTree.ts";

/**
 * Adds non-archived delegates running in *other* projects (e.g. via `tide_delegate(repo: ...)`)
 * into a group's child index so a parent's nested list matches its `N delegated` header count
 * even while the rail is filtered to a single project.
 */
function withCrossProjectDelegates(
  base: Map<string, Thread[]>,
  listedIds: ReadonlySet<string>,
  allThreads: Record<string, Thread>,
): Map<string, Thread[]> {
  const byParent = new Map<string, Thread[]>();
  for (const t of Object.values(allThreads)) {
    if (t.archivedAt !== undefined || t.delegatedBy === undefined) continue;
    const list = byParent.get(t.delegatedBy);
    if (list === undefined) byParent.set(t.delegatedBy, [t]);
    else list.push(t);
  }
  if (byParent.size === 0) return base;
  const seen = new Set(listedIds);
  const queue = [...listedIds];
  let merged: Map<string, Thread[]> | undefined;
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    const kids = byParent.get(parentId);
    if (!kids) continue;
    const extras = kids.filter((k) => !seen.has(k.id)).sort(compareByAttention);
    if (extras.length === 0) continue;
    merged ??= new Map([...base.entries()].map(([k, v]) => [k, [...v]]));
    const existing = merged.get(parentId) ?? [];
    for (const extra of extras) {
      seen.add(extra.id);
      existing.push(extra);
      queue.push(extra.id);
    }
    merged.set(parentId, existing);
  }
  return merged ?? base;
}

/** One rail group with its rows resolved: loose roots and the nodes of its sessions' threads. */
export interface RailGroupView {
  group: RailGroup;
  /** threads not claimed by a session whose parent is not listed here, with their children */
  roots: readonly RailNode[];
  /** a listed session's thread id → its node (children found among every live thread) */
  sessionNodes: ReadonlyMap<string, RailNode>;
}

export interface RailView {
  groups: RailGroupView[];
  /** every non-archived thread of the scope, in group order */
  live: Thread[];
}

interface NeedsMemo {
  threads: ReadModel["threads"];
  activities: ReadModel["activities"];
  plans: ReadModel["plans"];
  timeline: ReadModel["threadTimeline"];
  scope: string;
  now: number;
  key: string;
}

/**
 * The rail's groups, rebuilt only when what they are made of changes: the threads
 * map, the Experts sessions, the inbox order, the scope, the minute clock or the
 * Working setting. A streaming delta replaces none of these, so it costs the rail
 * nothing. The inbox order is selected apart as a string (it reads activities and
 * plans, which change far more often than the order does).
 */
export function useRailGroups(projectIds: readonly string[], now: number, workingSection: boolean | undefined): RailView {
  const scopeKey = projectIds.join("\n");
  const needsMemo = useRef<NeedsMemo | undefined>(undefined);
  const needsKey = useModel((s) => {
    const m = s.model;
    const c = needsMemo.current;
    if (c !== undefined && c.threads === m.threads && c.activities === m.activities && c.plans === m.plans && c.timeline === m.threadTimeline && c.scope === scopeKey && c.now === now) {
      return c.key;
    }
    const key = railNeedsOrder(m, projectIds, now).join("\n");
    needsMemo.current = { threads: m.threads, activities: m.activities, plans: m.plans, timeline: m.threadTimeline, scope: scopeKey, now, key };
    return key;
  });
  const threads = useModel((s) => s.model.threads);
  const expertsSessions = useModel((s) => s.model.expertsSessions);
  const builder = useRef<RailTreeBuilder | null>(null);
  builder.current ??= new RailTreeBuilder();
  const tree = builder.current;

  return useMemo(() => {
    // the rail reads only these two maps of the model; the rest is whatever is current
    const model: ReadModel = { ...useModel.getState().model, threads, expertsSessions };
    const ids = scopeKey === "" ? [] : scopeKey.split("\n");
    const needsOrder = needsKey === "" ? [] : needsKey.split("\n");
    const groups = buildRailGroups(model, ids, now, workingSection === undefined ? {} : { workingSection }, needsOrder);
    const claimed = claimedBy(groups.flatMap((g) => g.sessions));
    const live = groups.filter((g) => g.key !== "archived").flatMap((g) => g.threads);
    const liveIds = new Set(live.map((t) => t.id));
    const liveIndex = withCrossProjectDelegates(childrenIndex(live), liveIds, threads);
    tree.begin();
    const views = groups.map((group): RailGroupView => {
      const loose = group.key === "archived" ? group.threads : group.threads.filter((t) => !claimed.has(t.id));
      const listed = new Set(loose.map((t) => t.id));
      const roots = loose.filter((t) => {
        const parent = parentOf(t);
        return parent === undefined || !listed.has(parent);
      });
      const sessionNodes = new Map<string, RailNode>();
      for (const session of group.sessions) {
        for (const id of sessionThreadIds(session)) {
          const thread = threads[id];
          if (thread !== undefined && liveIds.has(id)) sessionNodes.set(id, tree.node(`${group.key}:session`, thread, liveIndex));
        }
      }
      const childIndex = group.key === "archived" ? childrenIndex(loose) : withCrossProjectDelegates(childrenIndex(loose), listed, threads);
      return { group, roots: tree.list(group.key, roots, childIndex), sessionNodes };
    });
    return { groups: views, live };
  }, [threads, expertsSessions, needsKey, scopeKey, now, workingSection, tree]);
}
