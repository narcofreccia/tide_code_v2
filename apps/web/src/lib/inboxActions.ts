import type { ReadModel, Thread } from "@tide/contracts";
import { call, dispatch, useModel } from "../state/model.ts";
import { isToastLive, showToast } from "../state/toast.ts";
import { errorText } from "./dispatchOrToast.ts";
import { plural } from "./format.ts";
import { mergeBlockedReason } from "./merge.ts";
import { canMergeBack } from "./threadActions.ts";
import { formatUntil } from "./turnActions.ts";

/** The Undo toast after a settle stays up this long. */
export const SETTLE_TOAST_MS = 8000;

interface SettleBatch {
  ids: string[];
  toastId: number;
}

/** Settles this session made, newest last: what ⌘Z walks back through. */
let undoStack: SettleBatch[] = [];
const UNDO_DEPTH = 20;

function titleOf(threadId: string): string {
  return useModel.getState().model.threads[threadId]?.title ?? "thread";
}

function settleOne(threadId: string): Promise<unknown> {
  return dispatch({ type: "thread.settle", threadId });
}

function unsettleOne(threadId: string): Promise<unknown> {
  return dispatch({ type: "thread.unsettle", threadId });
}

/** Unsettles every id; one toast for any refusal. */
function unsettleAll(ids: string[]): void {
  void Promise.allSettled(ids.map(unsettleOne)).then((results) => {
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) showToast(`Undoing the settle failed: ${errorText(failed.reason)}`);
  });
}

function pushUndo(ids: string[], toastId: number): void {
  undoStack = [...undoStack, { ids, toastId }].slice(-UNDO_DEPTH);
}

/**
 * Settles threads (the inbox's soft close: worktree and branch stay). One toast
 * with Undo for the whole batch; ⌘Z does the same while it is up.
 */
export async function settleThreads(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const results = await Promise.allSettled(ids.map(settleOne));
  const done = ids.filter((_, i) => results[i]?.status === "fulfilled");
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (done.length === 0) {
    showToast(`Settling failed: ${errorText(failed?.reason)}`);
    return;
  }
  const text =
    done.length === 1 ? `Settled “${titleOf(done[0] ?? "")}”` : `Settled ${plural(done.length, "thread")}`;
  const suffix = failed ? ` · ${ids.length - done.length} refused: ${errorText(failed.reason)}` : "";
  let toastId = 0;
  toastId = showToast(
    `${text}${suffix}`,
    {
      label: "Undo",
      onClick: () => {
        undoStack = undoStack.filter((b) => b.toastId !== toastId);
        unsettleAll(done);
      },
    },
    { ms: SETTLE_TOAST_MS },
  );
  pushUndo(done, toastId);
}

export function settleThread(threadId: string): void {
  void settleThreads([threadId]);
}

export function unsettleThread(threadId: string): void {
  undoStack = undoStack.map((b) => ({ ...b, ids: b.ids.filter((id) => id !== threadId) })).filter((b) => b.ids.length > 0);
  unsettleAll([threadId]);
}

/** True when a settle made in this session can still be undone. */
export function canUndoSettle(): boolean {
  return undoStack.length > 0;
}

/** True while the newest settle's Undo toast is still on screen. */
export function settleToastLive(): boolean {
  const last = undoStack[undoStack.length - 1];
  return last !== undefined && isToastLive(last.toastId);
}

/** ⌘Z / "Undo settle": brings the newest settled batch back. False when there is nothing to undo. */
export function undoLastSettle(): boolean {
  const last = undoStack[undoStack.length - 1];
  if (!last) return false;
  undoStack = undoStack.slice(0, -1);
  unsettleAll(last.ids);
  showToast(last.ids.length === 1 ? `Unsettled “${titleOf(last.ids[0] ?? "")}”` : `Unsettled ${plural(last.ids.length, "thread")}`);
  return true;
}

/** Test seam: forget the session's settles. */
export function resetSettleUndo(): void {
  undoStack = [];
}

/** Snoozes every id until `until`; one toast for the batch. */
export async function snoozeThreads(ids: readonly string[], until: number): Promise<void> {
  if (ids.length === 0) return;
  const results = await Promise.allSettled(
    ids.map((threadId) => dispatch({ type: "thread.snooze", threadId, until })),
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (ok === 0) {
    showToast(`Snoozing failed: ${errorText(failed?.reason)}`);
    return;
  }
  showToast(
    `Snoozed ${plural(ok, "thread")} until ${formatUntil(until)}${failed ? ` · ${ids.length - ok} refused` : ""}`,
  );
}

/**
 * Asks the server for a fresh title per thread, one at a time (each is a one-shot
 * harness call on the user's subscription). The server applies the title itself.
 */
export async function regenerateTitles(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const failures: string[] = [];
  let last: string | undefined;
  for (const threadId of ids) {
    try {
      const result = await call("thread.regenerateTitle", { threadId });
      last = result.title;
    } catch (error) {
      failures.push(`${titleOf(threadId)}: ${errorText(error)}`);
    }
  }
  const ok = ids.length - failures.length;
  if (failures.length === 0) {
    showToast(ok === 1 && last !== undefined ? `Renamed to “${last}”` : `Regenerated ${plural(ok, "title")}`);
  } else if (ok === 0) {
    showToast(`Regenerating titles failed — ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ""}`);
  } else {
    showToast(`Regenerated ${plural(ok, "title")}, ${failures.length} failed — ${failures[0]}`);
  }
}

/** Threads among `ids` that a bulk merge-back can send: own branch, a worktree, not running or merged. */
export function mergeableOf(model: Pick<ReadModel, "threads">, ids: readonly string[]): Thread[] {
  const out: Thread[] = [];
  for (const id of ids) {
    const thread = model.threads[id];
    if (thread === undefined) continue;
    if (canMergeBack(thread) && thread.worktreePath !== undefined && mergeBlockedReason(thread, false) === undefined) {
      out.push(thread);
    }
  }
  return out;
}

/**
 * Merges the threads back one after another (the vcs reactor serialises per repo, and a
 * parallel burst would race on the base branch). Outcome toasts come from useMergeOutcomeToasts;
 * only a refused dispatch is reported here.
 */
export async function mergeBackThreads(ids: readonly string[]): Promise<void> {
  for (const threadId of ids) {
    try {
      await dispatch({ type: "thread.merge", threadId });
    } catch (error) {
      showToast(`Merge refused: ${titleOf(threadId)} — ${errorText(error)}`);
    }
  }
}

/** "2 running · 1 without a worktree": why selected threads are left out of a bulk merge-back. */
export function mergeSkipSummary(model: Pick<ReadModel, "threads">, ids: readonly string[]): string {
  const skipped = new Set(mergeableOf(model, ids).map((t) => t.id));
  const counts = { running: 0, merged: 0, "without a worktree": 0, "without a branch": 0, "not mergeable": 0 };
  for (const id of ids) {
    const t = model.threads[id];
    if (t === undefined || skipped.has(id)) continue;
    if (t.status === "running") counts.running++;
    else if (t.mergedAt !== undefined) counts.merged++;
    else if (t.branch === undefined) counts["without a branch"]++;
    else if (t.worktreePath === undefined) counts["without a worktree"]++;
    else counts["not mergeable"]++;
  }
  return Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(" · ");
}
