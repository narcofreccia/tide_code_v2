import { existsSync } from "node:fs";
import type { EventOf } from "@tide/contracts";
import { sharingThread } from "./restore.ts";
import { dispatch, info, message, post, threadContext, type VcsEnv } from "./reactorEnv.ts";
import { mergedSourceBase, notARepoText, NotARepositoryError, worktreeFailureText } from "./worktrees.ts";

/**
 * Worktree creation happens before the thread has a turn, so a failure is remembered here and
 * every turn of the thread is refused with an error row (see `recordBefore`): a thread that
 * asked for a worktree never runs in the project's main checkout.
 *
 * A fork of a thread that was merged back starts at the base branch it landed on when its
 * fork point (a checkpoint ref, removed with the merged branch) is gone: that is where the
 * source's work now lives. The first turn says so.
 */
export async function createWorktree(env: VcsEnv, threadId: string, startRef?: string): Promise<void> {
  const ctx = threadContext(env, threadId);
  if (!ctx) return;
  try {
    const landedOn = mergedSourceBase(ctx.model, ctx.thread);
    const created = await env.worktrees.create(ctx.project, ctx.thread, startRef, landedOn !== undefined ? { fallbackRef: `refs/heads/${landedOn}` } : {});
    if (created.fellBackTo !== undefined && landedOn !== undefined) {
      env.worktreeNotices.set(threadId, { kind: "info", text: `Started from ${landedOn}: the original checkpoint was removed after the merge.` });
    }
    await dispatch(env, {
      type: "worktree.attach",
      threadId,
      worktreePath: created.worktreePath,
      branch: created.branch,
      baseBranch: created.baseBranch,
    });
  } catch (err) {
    if (err instanceof NotARepositoryError) {
      // a folder without git has no worktrees to offer: the thread runs in it (said once)
      env.worktreeNotices.set(threadId, { kind: "error", text: notARepoText(err.message) });
      return;
    }
    env.worktreeFailures.set(threadId, message(err));
    env.log("[vcs] worktree creation failed; the thread's turns are refused until it has one", err);
  }
}

/**
 * A turn of a thread whose worktree could not be created: an error row on the turn, then the
 * turn settles as an error before the provider reactor opens a session (it re-checks the
 * status once the before-gate opens). Returns false when the thread has no such failure.
 */
export async function refuseWithoutWorktree(env: VcsEnv, threadId: string, turnId: string): Promise<boolean> {
  const reason = env.worktreeFailures.get(threadId);
  if (reason === undefined || env.engine.getModel().threads[threadId]?.worktreePath !== undefined) return false;
  try {
    await post(env, threadId, turnId, "error", worktreeFailureText(reason));
    await dispatch(env, { type: "turn.settle", turnId, status: "error", error: "no worktree: this thread will not run in the project's main checkout" });
  } finally {
    env.checkpoints.release(turnId);
  }
  return true;
}

/**
 * Tears a thread's worktree down: closes the harness session holding the cwd open, parks any
 * uncommitted work on a ref so archiving can never lose it, removes the checkout (the branch
 * survives) and records the fact through the server-internal command path. `deleteBranch` is
 * honoured only for Tide-owned `tide/*` branches — anything else is refused and logged.
 * A failure is posted on the thread as an error: the user must know the checkout is still there.
 * Returns true when the worktree is gone.
 */
export async function detach(env: VcsEnv, threadId: string, deleteBranchToo: boolean): Promise<boolean> {
  const ctx = threadContext(env, threadId);
  if (!ctx || ctx.thread.worktreePath === undefined) return false;
  const worktreePath = ctx.thread.worktreePath;
  try {
    await env.sessions?.close(threadId);
    // R5: a checkout another live thread still runs in (inheritWorktreeFrom) stays on disk,
    // with its branch; this thread only lets go of it
    const sharer = sharingThread(ctx.model, ctx.thread);
    if (sharer !== undefined) {
      env.log(`[vcs] worktree of ${threadId} kept: thread ${sharer.id} still uses it`);
      await dispatch(env, { type: "worktree.detached", threadId });
      return true;
    }
    try {
      await preserve(env, threadId, worktreePath);
    } catch (err) {
      // never remove a checkout whose uncommitted work could not be parked
      await info(env, threadId, "error", `Worktree kept: its uncommitted work could not be preserved (${message(err)})`);
      return false;
    }
    env.onDetach?.(threadId, worktreePath);
    await env.worktrees.remove(ctx.project, ctx.thread);
    if (deleteBranchToo) await deleteBranch(env, ctx.project.rootPath, ctx.thread.branch);
    await dispatch(env, { type: "worktree.detached", threadId });
    return true;
  } catch (err) {
    env.log("[vcs] worktree detach failed", err);
    await info(env, threadId, "error", `Worktree could not be removed: ${message(err)}`);
    return false;
  }
}

/** Uncommitted work in a worktree about to be deleted is parked on `refs/tide/archived/<threadId>`. */
async function preserve(env: VcsEnv, threadId: string, worktreePath: string): Promise<void> {
  const git = env.git(worktreePath);
  if (!(await git.isRepo())) return;
  if ((await git.status()).dirty === 0) return;
  const sha = await git.snapshot(`tide: archived worktree ${threadId}`);
  await git.updateRef(`refs/tide/archived/${threadId}`, sha);
  env.log(`[vcs] uncommitted work preserved at refs/tide/archived/${threadId}`, sha);
}

/** Drops `refs/tide/checkpoints/<threadId>/*`; called only once the thread's branch is deleted. */
export async function gcCheckpoints(env: VcsEnv, threadId: string): Promise<void> {
  const ctx = threadContext(env, threadId);
  if (!ctx) return;
  try {
    const removed = await env.checkpoints.deleteThreadRefs(ctx.project.rootPath, threadId);
    if (removed > 0) env.log(`[vcs] removed ${removed} checkpoint ref(s) of ${threadId}`);
  } catch (err) {
    env.log("[vcs] checkpoint ref cleanup failed", err);
  }
}

/**
 * `thread.deleted`: the thread is already gone from the model, so everything comes from the
 * event. Session, worktree, `tide/*` branch, checkpoint refs and the archived-work ref go, each
 * best-effort and logged (there is no thread left to post an error on). Nothing still in the
 * model is touched: a checkout or branch another thread uses stays. A cascade sharing one
 * checkout removes it on the first event; later ones find it gone and skip quietly.
 */
export async function destroy(env: VcsEnv, event: EventOf<"thread.deleted">): Promise<void> {
  const { threadId, worktreePath, branch } = event;
  const model = env.engine.getModel();
  const project = model.projects[event.projectId];
  const step = async (what: string, task: () => Promise<void>): Promise<void> => {
    try {
      await task();
    } catch (err) {
      env.log(`[vcs] delete ${threadId}: ${what} failed`, err);
    }
  };
  await step("session close", async () => void (await env.sessions?.close(threadId)));
  if (!project) {
    env.log(`[vcs] delete ${threadId}: unknown project ${event.projectId}; repository left as is`);
    return;
  }
  const others = Object.values(model.threads).filter((t) => t.id !== threadId);
  if (worktreePath !== undefined) {
    if (worktreePath === project.rootPath || others.some((t) => t.worktreePath === worktreePath)) {
      env.log(`[vcs] delete ${threadId}: worktree ${worktreePath} kept, still in use`);
    } else {
      env.onDetach?.(threadId, worktreePath);
      if (existsSync(worktreePath)) await step("worktree removal", () => env.worktrees.removePath(project.rootPath, worktreePath));
    }
  }
  if (branch !== undefined && others.some((t) => t.branch === branch)) {
    env.log(`[vcs] delete ${threadId}: branch ${branch} kept, another thread uses it`);
  } else if (branch !== undefined && (await env.git(project.rootPath).revParse(`refs/heads/${branch}`)) === undefined) {
    // already gone: an earlier thread of the same cascade shared it
  } else {
    await step("branch deletion", () => deleteBranch(env, project.rootPath, branch));
  }
  await step("checkpoint ref cleanup", async () => {
    const removed = await env.checkpoints.deleteThreadRefs(project.rootPath, threadId);
    if (removed > 0) env.log(`[vcs] removed ${removed} checkpoint ref(s) of ${threadId}`);
  });
  await step("archived ref cleanup", () => env.git(project.rootPath).deleteRef(`refs/tide/archived/${threadId}`));
  env.worktreeFailures.delete(threadId);
  env.worktreeNotices.delete(threadId);
}

async function deleteBranch(env: VcsEnv, rootPath: string, branch: string | undefined): Promise<void> {
  if (branch === undefined) return;
  if (!branch.startsWith("tide/")) {
    env.log(`[vcs] refusing to delete ${branch}: only tide/* branches are Tide's to remove`);
    return;
  }
  if (!(await env.git(rootPath).deleteBranch(branch))) env.log(`[vcs] could not delete branch ${branch}`);
}
