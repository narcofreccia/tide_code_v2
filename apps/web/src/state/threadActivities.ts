import { useEffect, useSyncExternalStore } from "react";
import { createThreadActivities, selectThreadTurns, type ThreadActivities, type ThreadWindow } from "@tide/client";
import { mergeActivities, type Activity, type ReadModel } from "@tide/contracts";
import { allStores, call, storeForThread, useModel } from "./model.ts";

/*
 * R24: the app's thread activity windows (see `@tide/client` threadActivities). Every
 * surface that renders a thread's activities (the stream in the thread column and side
 * panes) opens the thread here; the store holds only resident activities otherwise.
 */

/** `thread.activities` takes at most this many turns per call. */
const MAX_TURNS_PER_CALL = 500;

/** The owner's snapshot epoch; undefined for a store holding the full model (tests, `attachModelStore`). */
function epochOf(threadId: string): number | undefined {
  const store = storeForThread(threadId);
  if (store === undefined || store.mergeActivities === undefined) return undefined;
  return store.getState().epoch ?? 0;
}

async function fetchActivities(threadId: string, turnIds: readonly string[]): Promise<Activity[]> {
  const out: Activity[] = [];
  for (let i = 0; i < turnIds.length; i += MAX_TURNS_PER_CALL) {
    const reply = await call("thread.activities", { threadId, turnIds: turnIds.slice(i, i + MAX_TURNS_PER_CALL) });
    out.push(...reply.activities);
  }
  return out;
}

let tracker: ThreadActivities | undefined;

export function threadActivities(): ThreadActivities {
  tracker ??= createThreadActivities({
    getModel: () => useModel.getState().model,
    epoch: epochOf,
    fetch: fetchActivities,
    merge: (threadId, activities) => storeForThread(threadId)?.mergeActivities?.(activities),
    drop: (ids) => {
      for (const store of allStores()) store.dropActivities?.(ids);
    },
    subscribe: (listener) => useModel.subscribe(listener),
  });
  return tracker;
}

/** Test seam: forget every window. */
export function resetThreadActivities(): void {
  tracker?.dispose();
  tracker = undefined;
}

const subscribe = (listener: () => void): (() => void) => threadActivities().subscribe(listener);

/** Opens the thread's activity window while the caller is mounted, and follows it. */
export function useThreadWindow(threadId: string): ThreadWindow {
  useEffect(() => threadActivities().open(threadId), [threadId]);
  return useSyncExternalStore(subscribe, () => threadActivities().windowOf(threadId));
}

/**
 * The model with every activity of the thread, for a whole-thread export. Fetched for this
 * call only (not merged into the store): an export must not undo the pruning.
 */
export async function modelWithAllActivities(threadId: string): Promise<ReadModel> {
  const model = useModel.getState().model;
  if (epochOf(threadId) === undefined) return model;
  const turnIds = selectThreadTurns(model, threadId).map((t) => t.id);
  const fetched = await fetchActivities(threadId, turnIds);
  const activities = mergeActivities(model.activities, fetched);
  return activities === model.activities ? model : { ...model, activities };
}
