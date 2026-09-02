import type { CommandOf, LinkAccess, Project, ReadModel, Thread } from "@tide/contracts";
import { fail, isArchived, ok, type DecideContext, type DecideResult } from "./types.ts";

type ThreadLink = { linkId: string; access: LinkAccess };

/**
 * A thread's links are resolved once, at creation: the requested overrides if any, else
 * every project link at its default access. An override can only ever *narrow* access —
 * a read-only project link stays read-only however the caller asks for it.
 */
function resolveLinks(project: Project, requested: ThreadLink[] | undefined): { links: ThreadLink[] } | { error: string } {
  const available = project.links ?? [];
  if (requested === undefined) return { links: available.map((l) => ({ linkId: l.id, access: l.access })) };
  const links: ThreadLink[] = [];
  for (const want of requested) {
    const link = available.find((l) => l.id === want.linkId);
    if (!link) return { error: want.linkId };
    links.push({ linkId: link.id, access: link.access === "read" ? "read" : want.access });
  }
  return { links };
}

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
      const resolved = resolveLinks(project, command.links);
      if ("error" in resolved) return fail("not-found", `unknown link ${resolved.error} on project ${project.id}`);
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
        ...(resolved.links.length > 0 || command.links !== undefined ? { links: resolved.links } : {}),
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
      // archiving tears the worktree down, so it must never run under a live harness
      if (thread.status === "running") return fail("busy", `thread ${thread.id} is running`);
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
