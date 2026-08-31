import type { CommandOf, ReadModel, Thread } from "@tide/contracts";
import { fail, isArchived, ok, type DecideContext, type DecideResult } from "./types.ts";

type ThreadCommand =
  | CommandOf<"thread.create">
  | CommandOf<"thread.update">
  | CommandOf<"thread.archive">;

export function decideThread(model: ReadModel, command: ThreadCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "thread.create": {
      const project = model.projects[command.projectId];
      if (!project) return fail("not-found", `unknown project ${command.projectId}`);
      if (isArchived(project)) return fail("conflict", `project ${project.id} is archived`);
      if (command.parentThreadId !== undefined && !model.threads[command.parentThreadId]) {
        return fail("not-found", `unknown parent thread ${command.parentThreadId}`);
      }
      const thread: Thread = {
        id: ctx.newId(),
        projectId: project.id,
        ...(command.parentThreadId !== undefined ? { parentThreadId: command.parentThreadId } : {}),
        title: command.title ?? "New thread",
        provider: command.provider,
        ...(command.model !== undefined ? { model: command.model } : {}),
        mode: command.mode ?? "approval-required",
        interaction: command.interaction ?? "default",
        status: "idle",
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      return ok({ type: "thread.created", thread, ...(command.useWorktree !== undefined ? { useWorktree: command.useWorktree } : {}) });
    }

    case "thread.update": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      const patch: Partial<Pick<Thread, "title" | "provider" | "model" | "mode" | "interaction">> = {
        ...(command.title !== undefined ? { title: command.title } : {}),
        ...(command.provider !== undefined ? { provider: command.provider } : {}),
        ...(command.model !== undefined ? { model: command.model } : {}),
        ...(command.mode !== undefined ? { mode: command.mode } : {}),
        ...(command.interaction !== undefined ? { interaction: command.interaction } : {}),
      };
      return ok({ type: "thread.updated", threadId: thread.id, patch, updatedAt: ctx.now });
    }

    case "thread.archive": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(thread)) return ok();
      // keepWorktree rides along so the vcs reactor knows whether to tear the worktree down
      return ok({
        type: "thread.archived",
        threadId: thread.id,
        archivedAt: ctx.now,
        ...(command.keepWorktree !== undefined ? { keepWorktree: command.keepWorktree } : {}),
      });
    }
  }
}
