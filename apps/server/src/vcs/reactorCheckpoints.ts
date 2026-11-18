import { dispatch, post, threadContext, type VcsEnv } from "./reactorEnv.ts";
import { refuseWithoutWorktree } from "./reactorWorktree.ts";

export async function recordBefore(env: VcsEnv, threadId: string, turnId: string): Promise<void> {
  if (await refuseWithoutWorktree(env, threadId, turnId)) return;
  const notice = env.worktreeNotices.get(threadId);
  if (notice !== undefined) {
    env.worktreeNotices.delete(threadId);
    await post(env, threadId, turnId, notice.kind, notice.text);
  }
  const ctx = threadContext(env, threadId);
  if (!ctx || !(await env.git(ctx.cwd).isRepo())) {
    env.checkpoints.release(turnId);
    return;
  }
  try {
    const { ref } = await env.checkpoints.recordBefore(ctx.cwd, threadId, turnId);
    await dispatch(env, { type: "checkpoint.record", turnId, phase: "before", ref });
  } catch (err) {
    env.checkpoints.release(turnId);
    env.log("[vcs] before-checkpoint failed", err);
  }
}

export async function recordAfter(env: VcsEnv, threadId: string, turnId: string): Promise<void> {
  const ctx = threadContext(env, threadId);
  if (!ctx) return;
  if (ctx.model.turns[turnId]?.checkpoint?.before === undefined) return; // nothing was snapshotted
  try {
    const { ref, stats } = await env.checkpoints.recordAfter(ctx.cwd, threadId, turnId);
    await dispatch(env, {
      type: "checkpoint.record",
      turnId,
      phase: "after",
      ref,
      ...(stats !== undefined ? { stats } : {}),
    });
  } catch (err) {
    env.log("[vcs] after-checkpoint failed", err);
  }
}
