import { useEffect } from "react";
import type { MergeState, ReadModel } from "@tide/contracts";
import { useModel } from "../state/model.ts";
import { showToast } from "../state/toast.ts";

type Seen = Map<string, MergeState | undefined>;

function snapshot(model: ReadModel): Seen {
  const seen: Seen = new Map();
  for (const thread of Object.values(model.threads)) seen.set(thread.id, thread.merge);
  return seen;
}

/**
 * Toasts for merges that settled since `seen`: a merge whose `at` moved and
 * whose status is now merged / conflicted / error. Pure apart from `seen`,
 * which it advances.
 */
export function mergeOutcomeToasts(seen: Seen, model: ReadModel): string[] {
  const out: string[] = [];
  for (const thread of Object.values(model.threads)) {
    const before = seen.get(thread.id);
    const after = thread.merge;
    seen.set(thread.id, after);
    if (!after || after.status === "merging") continue;
    if (before && before.at === after.at && before.status === after.status) continue;
    if (after.status === "merged") out.push(`Merged ${thread.title}${thread.baseBranch ? ` into ${thread.baseBranch}` : ""}`);
    else if (after.status === "conflicted") {
      const n = after.files?.length ?? 0;
      out.push(`Merge conflicted: ${thread.title}${n > 0 ? ` (${n} file${n === 1 ? "" : "s"})` : ""}`);
    } else out.push(`Merge failed: ${thread.title}${after.error ? ` — ${after.error}` : ""}`);
  }
  return out;
}

/**
 * Mounted once by the shell: a merge's outcome arrives as an event, possibly
 * long after the click, so it is announced wherever the user is. Merges that
 * already settled before mount are not re-announced.
 */
export function useMergeOutcomeToasts(): void {
  useEffect(() => {
    const seen = snapshot(useModel.getState().model);
    return useModel.subscribe((state) => {
      for (const text of mergeOutcomeToasts(seen, state.model)) showToast(text);
    });
  }, []);
}
