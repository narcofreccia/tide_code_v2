import type { CommandOf, ReadModel } from "@tide/contracts";
import { fail, isArchived, ok, type DecideContext, type DecideResult } from "./types.ts";

type VcsCommand =
  | CommandOf<"thread.revert">
  | CommandOf<"thread.publish">
  | CommandOf<"worktree.attach">
  | CommandOf<"checkpoint.record">
  | CommandOf<"pr.update">;

/**
 * Git-facing decisions. The decider only records *intent* (revert/publish) and the
 * *facts* the vcs reactor reports back (worktree attached, checkpoint recorded, PR
 * updated); it never touches git itself.
 */
export function decideVcs(model: ReadModel, command: VcsCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "thread.revert": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(thread)) return fail("conflict", `thread ${thread.id} is archived`);
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
      if (thread.status === "running") return fail("busy", `thread ${thread.id} is running`);
      return ok({
        type: "publish.requested",
        threadId: thread.id,
        ...(command.title !== undefined ? { title: command.title } : {}),
        ...(command.body !== undefined ? { body: command.body } : {}),
        ...(command.commitOnly !== undefined ? { commitOnly: command.commitOnly } : {}),
        at: ctx.now,
      });
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
