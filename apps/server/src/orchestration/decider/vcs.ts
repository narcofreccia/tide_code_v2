import type { CommandOf, ReadModel, Thread } from "@tide/contracts";
import { fail, isArchived, ok, type DecideContext, type DecideResult } from "./types.ts";

type VcsCommand =
  | CommandOf<"thread.publish">
  | CommandOf<"thread.merge">
  | CommandOf<"merge.report">
  | CommandOf<"worktree.attach">
  | CommandOf<"worktree.detach">
  | CommandOf<"checkpoint.record">
  | CommandOf<"pr.update">;

/**
 * Git-facing decisions. The decider only records *intent* (publish/merge) and the
 * *facts* the vcs reactor reports back (worktree attached, checkpoint recorded, PR
 * updated); it never touches git itself.
 */
/**
 * Publish commits and pushes everything in the thread's checkout. Without a worktree that
 * checkout *is* the user's main working copy, so the safe answer is to refuse.
 */
const NEEDS_WORKTREE = "runs in the main checkout; publish requires a worktree";

/**
 * R5: the live thread that owns the checkout `thread` runs in, when `thread` only inherited it
 * (`thread.delegate { inheritWorktreeFrom }`). The owner is the earliest live thread on that
 * path; once it is archived the checkout belongs to whoever still uses it.
 */
export function inheritedFrom(model: ReadModel, thread: Thread): Thread | undefined {
  if (thread.worktreePath === undefined) return undefined;
  let owner: Thread | undefined;
  for (const other of Object.values(model.threads)) {
    if (other.worktreePath !== thread.worktreePath || (isArchived(other) && other.id !== thread.id)) continue;
    if (owner === undefined || other.createdAt < owner.createdAt) owner = other;
  }
  return owner !== undefined && owner.id !== thread.id ? owner : undefined;
}

const inheritedRefusal = (thread: Thread, source: Thread): string =>
  `thread ${thread.id} runs in an inherited worktree: merge from "${source.title}" (${source.id})`;

export function decideVcs(model: ReadModel, command: VcsCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "thread.publish": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(thread)) return fail("conflict", `thread ${thread.id} is archived`);
      if (thread.worktreePath === undefined) return fail("conflict", `thread ${thread.id} ${NEEDS_WORKTREE}`);
      const publishSource = inheritedFrom(model, thread);
      if (publishSource) return fail("conflict", inheritedRefusal(thread, publishSource));
      if (thread.status === "running") return fail("busy", `thread ${thread.id} is running`);
      return ok({
        type: "publish.requested",
        threadId: thread.id,
        ...(command.title !== undefined ? { title: command.title } : {}),
        ...(command.body !== undefined ? { body: command.body } : {}),
        ...(command.commitOnly !== undefined ? { commitOnly: command.commitOnly } : {}),
        ...(command.mergeWhenGreen !== undefined ? { mergeWhenGreen: command.mergeWhenGreen } : {}),
        at: ctx.now,
      });
    }

    case "thread.merge": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(thread)) return fail("conflict", `thread ${thread.id} is archived`);
      if (thread.worktreePath === undefined || thread.branch === undefined) return fail("conflict", `thread ${thread.id} has no branch to merge back`);
      const mergeSource = inheritedFrom(model, thread);
      if (mergeSource) return fail("conflict", inheritedRefusal(thread, mergeSource));
      if (thread.status === "running") return fail("busy", `thread ${thread.id} is running`);
      if (thread.merge?.status === "merging") return fail("busy", `thread ${thread.id} is already merging`);
      if (thread.mergedAt !== undefined) return fail("conflict", `thread ${thread.id} is already merged`);
      return ok({
        type: "merge.requested",
        threadId: thread.id,
        strategy: command.strategy ?? "squash",
        ...(command.deleteBranch !== undefined ? { deleteBranch: command.deleteBranch } : {}),
        at: ctx.now,
      });
    }

    case "merge.report": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      const strategy = thread.merge?.strategy;
      if (thread.merge?.status !== "merging" || strategy === undefined) return fail("conflict", `thread ${thread.id} has no merge in flight`);
      if (command.outcome === "merged") {
        return ok({ type: "merge.completed", threadId: thread.id, strategy, ...(command.sha !== undefined ? { sha: command.sha } : {}), ...(command.branchDeleted !== undefined ? { branchDeleted: command.branchDeleted } : {}), at: ctx.now });
      }
      if (command.outcome === "conflicted") return ok({ type: "merge.conflicted", threadId: thread.id, strategy, files: command.files ?? [], at: ctx.now });
      return ok({ type: "merge.failed", threadId: thread.id, strategy, error: command.error ?? "merge failed", at: ctx.now });
    }

    case "worktree.attach": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      return ok({
        type: "worktree.attached",
        threadId: thread.id,
        worktreePath: command.worktreePath,
        branch: command.branch,
        ...(command.baseBranch !== undefined ? { baseBranch: command.baseBranch } : {}),
        at: ctx.now,
      });
    }

    case "worktree.detach": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (thread.worktreePath === undefined) return fail("conflict", `thread ${thread.id} has no worktree`);
      if (thread.status === "running") return fail("busy", `thread ${thread.id} is running`);
      return ok({
        type: "worktree.detach-requested",
        threadId: thread.id,
        ...(command.deleteBranch !== undefined ? { deleteBranch: command.deleteBranch } : {}),
        at: ctx.now,
      });
    }

    case "checkpoint.record": {
      const turn = model.turns[command.turnId];
      if (!turn) return fail("not-found", `unknown turn ${command.turnId}`);
      return ok({
        type: "checkpoint.recorded",
        turnId: turn.id,
        threadId: turn.threadId,
        phase: command.phase,
        ref: command.ref,
        ...(command.stats !== undefined ? { stats: command.stats } : {}),
        at: ctx.now,
      });
    }

    case "pr.update": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      return ok({ type: "pr.updated", threadId: thread.id, pr: command.pr });
    }
  }
}


/** `worktree.detached` — the reactor's report; idempotent when already detached. */
export function decideWorktreeDetached(model: ReadModel, command: CommandOf<"worktree.detached">, ctx: DecideContext): DecideResult {
  const thread = model.threads[command.threadId];
  if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
  if (thread.worktreePath === undefined) return ok();
  return ok({ type: "worktree.detached", threadId: thread.id, at: ctx.now });
}
