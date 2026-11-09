import { useEffect } from "react";
import { selectRepoSiblings } from "@tide/client";
import type { MergeState, Project, ReadModel, Thread } from "@tide/contracts";
import { envOfProject, envOfThread, useEnvironments } from "../state/environments.ts";
import { call, useModel } from "../state/model.ts";
import { showToast } from "../state/toast.ts";
import { plural } from "./format.ts";

type Seen = Map<string, MergeState | undefined>;

export interface MergeToast {
  text: string;
  /** R17 B4: a merge that landed on another machine — fast-forward this machine's checkout of the same repo */
  pull?: { projectId: string; base: string };
}

/** Who owns what; injected so the toast logic stays pure. */
export interface PullContext {
  primaryId: string | undefined;
  envOfThread: (threadId: string) => string | undefined;
  envOfProject: (projectId: string) => string | undefined;
}

function snapshot(model: ReadModel): Seen {
  const seen: Seen = new Map();
  for (const thread of Object.values(model.threads)) seen.set(thread.id, thread.merge);
  return seen;
}

/**
 * R17 B4: a thread merged on a machine other than the primary pushed its base there; the
 * primary's own checkout of the same repo (a sibling project) is what "Pull here" updates.
 */
export function pullTargetFor(model: ReadModel, thread: Thread, ctx: PullContext): Project | undefined {
  const owner = ctx.envOfThread(thread.id);
  if (owner === undefined || ctx.primaryId === undefined || owner === ctx.primaryId) return undefined;
  return selectRepoSiblings(model, thread.projectId).find((p) => ctx.envOfProject(p.id) === ctx.primaryId);
}

/**
 * Toasts for merges that settled since `seen`: a merge whose `at` moved and whose status is
 * now merged / conflicted / error. Pure apart from `seen`, which it advances.
 */
export function mergeToastItems(seen: Seen, model: ReadModel, ctx?: PullContext): MergeToast[] {
  const out: MergeToast[] = [];
  for (const thread of Object.values(model.threads)) {
    const before = seen.get(thread.id);
    const after = thread.merge;
    seen.set(thread.id, after);
    if (!after || after.status === "merging") continue;
    if (before && before.at === after.at && before.status === after.status) continue;
    if (after.status === "merged") {
      const text = `Merged ${thread.title}${thread.baseBranch ? ` into ${thread.baseBranch}` : ""}`;
      const target = ctx === undefined ? undefined : pullTargetFor(model, thread, ctx);
      const base = thread.baseBranch ?? target?.repo?.defaultBranch;
      out.push(target !== undefined && base !== undefined ? { text, pull: { projectId: target.id, base } } : { text });
    } else if (after.status === "conflicted") {
      const n = after.files?.length ?? 0;
      out.push({ text: `Merge conflicted: ${thread.title}${n > 0 ? ` (${plural(n, "file")})` : ""}` });
    } else out.push({ text: `Merge failed: ${thread.title}${after.error ? ` — ${after.error}` : ""}` });
  }
  return out;
}

/** The toast texts alone (no pull actions). */
export function mergeOutcomeToasts(seen: Seen, model: ReadModel): string[] {
  return mergeToastItems(seen, model).map((t) => t.text);
}

/** "Pull main here": fast-forwards the project's base checkout from origin and says how it went. */
export async function pullBaseHere(projectId: string, base: string): Promise<void> {
  try {
    const result = await call("vcs.pullBase", { projectId });
    showToast(result.ok ? `Pulled ${base}${result.sha ? ` (${result.sha.slice(0, 8)})` : ""}` : `Pull failed: ${result.error ?? "unknown error"}`);
  } catch (err) {
    showToast(`Pull failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function pullContext(): PullContext {
  return { primaryId: useEnvironments.getState().primaryId, envOfThread, envOfProject };
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
      for (const toast of mergeToastItems(seen, state.model, pullContext())) {
        const pull = toast.pull;
        if (pull === undefined) showToast(toast.text);
        else showToast(toast.text, { label: `Pull ${pull.base} here`, onClick: () => void pullBaseHere(pull.projectId, pull.base) });
      }
    });
  }, []);
}
