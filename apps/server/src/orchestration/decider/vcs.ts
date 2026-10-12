import type { CommandOf, ReadModel } from "@tide/contracts";
import { fail, isArchived, ok, type DecideContext, type DecideResult } from "./types.ts";

type VcsCommand =
  | CommandOf<"thread.revert">
  | CommandOf<"thread.publish">
  | CommandOf<"thread.merge">
  | CommandOf<"merge.report">
  | CommandOf<"worktree.attach">
  | CommandOf<"worktree.detach">
  | CommandOf<"checkpoint.record">
  | CommandOf<"pr.update">;

/**
 * Git-facing decisions. The decider only records *intent* (revert/publish) and the
 * *facts* the vcs reactor reports back (worktree attached, checkpoint recorded, PR
 * updated); it never touches git itself.
 */
/**
 * Both git-destructive commands operate on the thread's checkout: revert runs
 * `read-tree --reset -u` + `clean -fd`, publish commits and pushes everything in it. Without a
 * worktree that checkout *is* the user's main working copy, so the safe answer is to refuse.
 */
const NEEDS_WORKTREE = "runs in the main checkout; revert/publish require a worktree";

export function decideVcs(model: ReadModel, command: VcsCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "thread.revert": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(thread)) return fail("conflict", `thread ${thread.id} is archived`);
      if (thread.worktreePath === undefined) return fail("conflict", `thread ${thread.id} ${NEEDS_WORKTREE}`);
      const turn = model.turns[command.turnId];
      if (!turn) return fail("not-found", `unknown turn ${command.turnId}`);
      if (turn.threadId !== thread.id) return fail("conflict", `turn ${turn.id} does not belong to thread ${thread.id}`);
      if (turn.checkpoint?.before === undefined) return fail("conflict", `turn ${turn.id} has no before-checkpoint`);
      if (thread.status === "running") return fail("busy", `thread ${thread.id} is running`);
      return ok({ type: "revert.requested", threadId: thread.id, turnId: turn.id, at: ctx.now });
    }

    case "thread.publish": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(thread)) return fail("conflict", `thread ${thread.id} is archived`);
      if (thread.worktreePath === undefined) return fail("conflict", `thread ${thread.id} ${NEEDS_WORKTREE}`);
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
