import type { MergeStrategy } from "@tide/contracts";
import { hasOrigin, pushBase, pushThreadBranch, syncBase } from "./remoteSync.ts";
import { dispatch, gitSettings, info, threadContext, type VcsEnv } from "./reactorEnv.ts";
import { detach, gcCheckpoints } from "./reactorWorktree.ts";

/**
 * B4: pushes the thread's `tide/*` branch to origin and records it (`branch.pushed`). Only what
 * is committed on the branch travels. A failure is said once per failure streak (info), and the
 * merge or checkpoint that asked for the push carries on. Returns true when origin has the branch.
 */
export async function pushBranch(env: VcsEnv, threadId: string): Promise<boolean> {
  const ctx = threadContext(env, threadId);
  const branch = ctx?.thread.branch;
  if (!ctx || branch === undefined || ctx.thread.worktreePath === undefined) return false;
  const root = env.git(ctx.project.rootPath);
  if (!(await hasOrigin(root))) return false;
  const sha = await root.revParse(`refs/heads/${branch}`);
  if (sha !== undefined && ctx.thread.pushedSha === sha && ctx.thread.remoteBranch === branch) return true;
  const pushed = await pushThreadBranch(root, branch);
  if (pushed.ok) {
    env.pushMuted.delete(threadId);
    await dispatch(env, { type: "branch.pushed", threadId, remoteBranch: pushed.remoteBranch, sha: pushed.sha });
    return true;
  }
  if (!env.pushMuted.has(threadId)) {
    env.pushMuted.add(threadId);
    await info(env, threadId, "info", `Could not push ${branch} to origin: ${pushed.error}`);
  }
  return false;
}

/**
 * Merge-back of the thread's branch into its base (see MergeBack). The outcome is reported as
 * `merge.report`; with `deleteBranch` the worktree goes through the ordinary detach path, the
 * `tide/*` branch is deleted and the thread's checkpoint refs are dropped.
 *
 * With an origin: `syncBaseWithRemote` fetches and fast-forwards the base before a local merge
 * (an unreachable origin only warns; a dirty-behind or diverged base refuses), and
 * `pushBaseAfterMerge` pushes the base after it. The two are independent; the push is off by default.
 */
export async function mergeBack(env: VcsEnv, threadId: string, strategy: MergeStrategy, deleteBranch: boolean, journalKey: string): Promise<void> {
  const ctx = threadContext(env, threadId);
  if (!ctx) return;
  const { thread, project } = ctx;
  const settings = gitSettings(env);
  const root = env.git(project.rootPath);
  const remote =
    (settings.pushThreadBranches !== "never" || settings.syncBaseWithRemote || settings.pushBaseAfterMerge) && (await hasOrigin(root));
  const local = !(await env.merge.usesPr(thread));
  if (remote && settings.pushThreadBranches === "on-merge-request") {
    await env.merge.commitPending(thread).catch((err: unknown) => env.log("[vcs] commit before push failed", err));
    await pushBranch(env, threadId);
  }
  let synced: string | undefined;
  if (remote && local && settings.syncBaseWithRemote && thread.baseBranch !== undefined) {
    // a known-stale base is never merged into: fast-forward from origin first, or refuse
    const before = await syncBase(root, thread.baseBranch);
    if (!before.ok) {
      await dispatch(env, { type: "merge.report", threadId, outcome: "error", error: before.note });
      await info(env, threadId, "error", `Merge not started: ${before.note}`);
      return;
    }
    synced = before.note;
    // origin out of reach: the merge proceeds on the local base, and the thread says so
    if (before.warning !== undefined) await info(env, threadId, "info", `Base not synced: ${before.warning}`);
  }
  // R19 L3: the base head the local merge starts from, and below the commit it moved to, so a
  // restart between the base moving and the report can still tell the merge landed
  const baseSha = local && thread.baseBranch !== undefined ? await root.revParse(`refs/heads/${thread.baseBranch}`) : undefined;
  if (baseSha !== undefined) env.journal?.begin(journalKey, { threadId, kind: "merge", baseSha });
  const result = await env.merge.merge(project, thread, strategy, deleteBranch);
  if (baseSha !== undefined && result.outcome === "merged" && result.sha !== undefined && result.pr === undefined) {
    env.journal?.begin(journalKey, { threadId, kind: "merge", baseSha, landed: result.sha });
  }
  if (result.outcome === "conflicted") {
    await dispatch(env, { type: "merge.report", threadId, outcome: "conflicted", files: result.files });
    await info(env, threadId, "error", `Merge into ${thread.baseBranch ?? "base"} conflicts in ${result.files.join(", ")}; nothing was changed`);
    return;
  }
  if (result.outcome === "error") {
    await dispatch(env, { type: "merge.report", threadId, outcome: "error", error: result.error });
    await info(env, threadId, "error", `Merge failed: ${result.error}`);
    return;
  }
  if (result.pr !== undefined) await dispatch(env, { type: "pr.update", threadId, pr: result.pr });
  let branchDeleted = false;
  if (deleteBranch) {
    await detach(env, threadId, true);
    branchDeleted = thread.branch !== undefined && (await env.git(project.rootPath).revParse(`refs/heads/${thread.branch}`)) === undefined;
    await gcCheckpoints(env, threadId);
  }
  await dispatch(env, {
    type: "merge.report",
    threadId,
    outcome: "merged",
    ...(result.sha !== undefined ? { sha: result.sha } : {}),
    ...(deleteBranch ? { branchDeleted } : {}),
  });
  env.onPrChange?.(threadId);
  const where = result.pr !== undefined ? `via pull request #${result.pr.number}` : `(${strategy}${result.sha !== undefined ? ` ${result.sha.slice(0, 8)}` : ""})`;
  const notes = [synced, result.note].filter((n): n is string => n !== undefined).map((n) => `. ${n}`).join("");
  await info(env, threadId, "info", `Merged ${thread.branch ?? "branch"} into ${thread.baseBranch ?? "base"} ${where}${notes}`);
  if (remote && local && settings.pushBaseAfterMerge && thread.baseBranch !== undefined && result.pr === undefined) {
    // the merge stands either way (settle already fired); a failed push is the user's to resolve
    const pushed = await pushBase(root, thread.baseBranch);
    if (!pushed.ok) await info(env, threadId, "error", `${thread.baseBranch} merged locally but not pushed: ${pushed.error}`);
  }
}
