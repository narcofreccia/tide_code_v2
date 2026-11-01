import type { TimelineItem } from "@tide/client";
import type { Activity, Turn, TurnStatus } from "@tide/contracts";

/*
 * The pure shaping of a thread's timeline into stream rows (R15: memoized in `Stream`
 * on the thread's own timeline and turns, never on the whole model).
 */

export interface Split {
  top: TimelineItem[];
  /** childKey -> the sub-agent's own activities, pulled out of the main flow */
  nested: Map<string, Activity[]>;
}

/** Moves sub-agent output under its child header so the main flow stays readable. */
export function splitChildren(entries: readonly TimelineItem[]): Split {
  const children = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "activity" && entry.activity.kind === "child") children.add(entry.activity.childKey);
  }
  const nested = new Map<string, Activity[]>();
  const top: TimelineItem[] = [];
  for (const entry of entries) {
    if (entry.kind === "activity" && entry.activity.kind !== "child") {
      const parent = entry.activity.parentToolUseId;
      if (parent !== undefined && children.has(parent)) {
        const list = nested.get(parent);
        if (list) list.push(entry.activity);
        else nested.set(parent, [entry.activity]);
        continue;
      }
    }
    top.push(entry);
  }
  return { top, nested };
}

const SETTLED: TurnStatus[] = ["completed", "error", "interrupted"];

/**
 * The messages that carry a turn footer: the last assistant message of every
 * turn that has settled. A turn still running keeps its numbers to itself.
 */
export function metaMessageIds(entries: readonly TimelineItem[], turns: readonly Turn[]): Set<string> {
  const last = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "assistant") {
      last.set(entry.message.turnId, entry.message.id);
    }
  }
  const status = new Map(turns.map((turn) => [turn.id, turn.status] as const));
  const out = new Set<string>();
  for (const [turnId, messageId] of last) {
    const s = status.get(turnId);
    if (s !== undefined && SETTLED.includes(s)) out.add(messageId);
  }
  return out;
}

/** Every activity of each turn, nested sub-agent rows included, for the turn's conclusion line. */
export function activitiesByTurn(entries: readonly TimelineItem[]): Map<string, Activity[]> {
  const out = new Map<string, Activity[]>();
  for (const entry of entries) {
    if (entry.kind !== "activity") continue;
    const list = out.get(entry.activity.turnId);
    if (list) list.push(entry.activity);
    else out.set(entry.activity.turnId, [entry.activity]);
  }
  return out;
}

export function lastPendingApprovalId(entries: readonly TimelineItem[]): string | undefined {
  let id: string | undefined;
  for (const entry of entries) {
    if (entry.kind === "activity" && entry.activity.kind === "approval" && entry.activity.status === "pending") {
      id = entry.activity.id;
    }
  }
  return id;
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Keeps list props stable across rebuilds: `stable(key, list)` hands back the list it
 * returned for `key` in the previous build when the items are the same, so a memoized
 * row given a freshly built array does not re-render. `lists` is the map to pass as
 * `prev` to the next build.
 */
export function listStabilizer<T>(prev: ReadonlyMap<string, T[]>): { stable: (key: string, list: T[]) => T[]; lists: Map<string, T[]> } {
  const lists = new Map<string, T[]>();
  return {
    lists,
    stable: (key, list) => {
      const old = prev.get(key);
      const kept = old !== undefined && sameList(old, list) ? old : list;
      lists.set(key, kept);
      return kept;
    },
  };
}
