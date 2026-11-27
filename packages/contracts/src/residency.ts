import type { Activity, ReadModel } from "./domain.ts";

/**
 * Activity residency (R24). The full activity map is the bulk of the read model (tens of MB
 * across long-lived threads), and every client-side projection of an `activity.upserted`
 * copies it. So a client subscribes with `scope: "resident"` and only holds:
 *
 * - the **resident** activities of every thread — the ones the rail, inbox, live labels and
 *   background-agent counts read without opening a thread (this predicate), and
 * - the activities of the threads it opened, fetched a window of turns at a time with
 *   `thread.activities`.
 *
 * Every event is still streamed; an upsert of an activity the client does not hold simply
 * adds it. Events that patch an existing activity (`approval.responded`,
 * `user-input.responded`, `turn.settled`) only ever touch resident ones, so a client that
 * lacks a non-resident activity never misses a patch to it.
 */
export function isResidentActivity(model: Pick<ReadModel, "turns">, a: Activity): boolean {
  if ((a.kind === "approval" || a.kind === "user-input") && a.status === "pending") return true;
  if (a.kind === "child" && a.status === "running") return true;
  if (a.kind === "tool" && a.status === "running") return true;
  // the in-flight turn: live labels ("Thinking", "Editing foo.ts") read its tail
  const turn = model.turns[a.turnId];
  return turn !== undefined && turn.settledAt === undefined;
}

/** The model with only its resident activities: the snapshot of a `scope: "resident"` subscription. */
export function residentModel(model: ReadModel): ReadModel {
  const activities: ReadModel["activities"] = {};
  for (const [id, a] of Object.entries(model.activities)) if (isResidentActivity(model, a)) activities[id] = a;
  return { ...model, activities };
}

/**
 * The activities of `threadId` whose turn is one of `turnIds`, in timeline order.
 * Serves `thread.activities`.
 */
export function threadActivitiesOf(model: ReadModel, threadId: string, turnIds: readonly string[]): Activity[] {
  const wanted = new Set(turnIds);
  const out: Activity[] = [];
  for (const e of model.threadTimeline[threadId] ?? []) {
    if (e.kind !== "activity") continue;
    const a = model.activities[e.id];
    if (a !== undefined && wanted.has(a.turnId)) out.push(a);
  }
  return out;
}

/**
 * Merge a `thread.activities` reply into a client's map. The reply is the server state at
 * some seq; live upserts the client already applied may be newer, so on a clash the copy
 * with the later `updatedAt` wins (the held one on a tie). Returns the same map when
 * nothing changed.
 */
export function mergeActivities(held: ReadModel["activities"], fetched: readonly Activity[]): ReadModel["activities"] {
  let next: ReadModel["activities"] | undefined;
  for (const a of fetched) {
    const prev = held[a.id];
    if (prev !== undefined && prev.updatedAt >= a.updatedAt) continue;
    next ??= { ...held };
    next[a.id] = a;
  }
  return next ?? held;
}
