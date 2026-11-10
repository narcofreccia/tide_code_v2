import type { Thread } from "@tide/contracts";
import { isThreadMerged } from "./selectors.ts";

/**
 * Why a new turn on this thread would be refused by the server, before the user types it.
 *
 * Mirrors the thread-level refusals of `turn.request` in
 * `apps/server/src/orchestration/decider/turns.ts` (the same rule guards `plan.implement`
 * here and `thread.resume` with continue). Refusals that depend on the command itself
 * (a duplicate requestId, a bad attachment, `/clear` while a turn runs) are not mirrored:
 * the composer handles those where they arise.
 */
export type SendBlockKind = "archived" | "rolling-back" | "worktree-merged" | "worktree-removed";

export interface SendBlock {
  kind: SendBlockKind;
  reason: string;
  /** the work can go on in a new thread forked from this one (the worktree is what is missing) */
  continueElsewhere: boolean;
}

export function threadSendBlock(thread: Thread): SendBlock | undefined {
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
  return undefined;
}
