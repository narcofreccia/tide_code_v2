import { isThreadMerged } from "@tide/client";
import type { MergeStrategy, Thread } from "@tide/contracts";

export const MERGE_STRATEGIES: { value: MergeStrategy; label: string; description: string }[] = [
  { value: "squash", label: "Squash", description: "one commit on the base branch" },
  { value: "merge", label: "Merge commit", description: "keep every commit, add a merge commit" },
  { value: "rebase", label: "Rebase", description: "replay the commits on top of the base" },
];

/** Why `thread.merge` cannot be sent right now, or undefined when it can. */
export function mergeBlockedReason(thread: Thread, running: boolean): string | undefined {
  if (thread.branch === undefined) return "This thread has no branch to merge";
  if (isThreadMerged(thread)) return "Already merged";
  if (thread.merge?.status === "merging") return "A merge is already running";
  if (running) return "Wait for the turn to finish";
  return undefined;
}

/** Where the merge lands, for labels: `tide/x → main`. */
export function mergeTarget(thread: Thread): string {
  return `${thread.branch ?? "branch"} → ${thread.baseBranch ?? "base"}`;
}
