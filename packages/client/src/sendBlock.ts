import type { ReadModel, Thread } from "@tide/contracts";
import { quotaHoldText, selectQuotaHold, type QuotaView } from "./quotaSelectors.ts";
import { isThreadMerged } from "./selectors.ts";

/**
 * Why a new turn on this thread would be refused by the server, before the user types it.
 *
 * Mirrors the thread-level refusals of `turn.request` in
 * `apps/server/src/orchestration/decider/turns.ts`, which `plan.implement` here also goes
 * through. `thread.resume` with continue (`decider/threads.ts`) refuses an archived thread and
 * one whose worktree was removed, but not one that is rolling back. Refusals that depend on the
 * command itself (a duplicate requestId, a bad attachment, `/clear` while a turn runs) are not
 * mirrored: the composer handles those where they arise.
 *
 * Not mirrored either: a thread whose worktree could not be created is refused by the vcs
 * reactor once the turn is sent (an error row on that turn), since the read model does not
 * record the failure.
 *
 * R20: with the model, a quota that holds the thread (`quotaBlock`: its own, an ancestor's or
 * its project's) is the `quota` kind; the decider refuses with `quota-exceeded`. A steer into a
 * running turn is not a new turn and is not held.
 */
export type SendBlockKind = "archived" | "rolling-back" | "worktree-merged" | "worktree-removed" | "quota";

export interface SendBlock {
  kind: SendBlockKind;
  reason: string;
  /** the work can go on in a new thread forked from this one (the worktree is what is missing) */
  continueElsewhere: boolean;
  /** the `quota` kind: the scope that holds, with its figures and reset time */
  quota?: QuotaView;
}

export function threadSendBlock(thread: Thread, ctx?: { model: ReadModel; now?: number }): SendBlock | undefined {
  if (thread.archivedAt !== undefined) {
    return { kind: "archived", reason: "This thread is archived.", continueElsewhere: false };
  }
  if (thread.rollback?.status === "rolling") {
    return { kind: "rolling-back", reason: "This thread is rolling back. Sending resumes when it finishes.", continueElsewhere: false };
  }
  if (thread.worktreePath === undefined && thread.branch !== undefined) {
    // running now would silently edit the user's main checkout
    return isThreadMerged(thread)
      ? { kind: "worktree-merged", reason: "This thread's worktree was removed after the merge.", continueElsewhere: true }
      : { kind: "worktree-removed", reason: "This thread's worktree was removed.", continueElsewhere: true };
  }
  const hold = ctx === undefined ? undefined : selectQuotaHold(ctx.model, thread, ctx.now ?? Date.now());
  if (hold !== undefined) return { kind: "quota", reason: `${quotaHoldText(hold)}.`, continueElsewhere: false, quota: hold };
  return undefined;
}
