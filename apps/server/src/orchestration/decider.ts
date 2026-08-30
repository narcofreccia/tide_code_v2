import type { Command, DomainEvent, Message, Project, ReadModel, Thread, Turn } from "@tide/contracts";

export interface DecideContext {
  now: number;
  newId: () => string;
}

export interface DecideError {
  code: string;
  message: string;
}

export type DecideResult =
  | { ok: true; events: DomainEvent[] }
  | { ok: false; error: DecideError };

const ok = (...events: DomainEvent[]): DecideResult => ({ ok: true, events });
const fail = (code: string, message: string): DecideResult => ({ ok: false, error: { code, message } });

const isArchived = (e: { archivedAt?: number }): boolean => e.archivedAt !== undefined;

/**
 * Pure decision function: (state, command) -> events | rejection.
 * Never touches the store, the clock or the id generator directly.
 */
export function decide(model: ReadModel, command: Command, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "project.create": {
      const clash = Object.values(model.projects).find(
        (p) => !isArchived(p) && p.rootPath === command.rootPath,
      );
      if (clash) return fail("conflict", `project already exists for rootPath ${command.rootPath}`);
      const project: Project = {
        id: ctx.newId(),
        title: command.title,
        rootPath: command.rootPath,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      return ok({ type: "project.created", project });
    }

    case "project.update": {
      const project = model.projects[command.projectId];
      if (!project) return fail("not-found", `unknown project ${command.projectId}`);
      return ok({
        type: "project.updated",
        projectId: project.id,
        ...(command.title !== undefined ? { title: command.title } : {}),
        updatedAt: ctx.now,
      });
    }

    case "project.archive": {
      const project = model.projects[command.projectId];
      if (!project) return fail("not-found", `unknown project ${command.projectId}`);
      if (isArchived(project)) return ok(); // idempotent
      return ok({ type: "project.archived", projectId: project.id, archivedAt: ctx.now });
    }

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
      return ok({ type: "thread.created", thread });
    }

    case "thread.update": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      const patch: { title?: string; provider?: Thread["provider"]; model?: string; mode?: Thread["mode"]; interaction?: Thread["interaction"] } = {
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
      return ok({ type: "thread.archived", threadId: thread.id, archivedAt: ctx.now });
    }

    case "turn.request": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(thread)) return fail("conflict", `thread ${thread.id} is archived`);
      if (thread.status === "running") return fail("busy", `thread ${thread.id} already has a running turn`);
      const turn: Turn = { id: ctx.newId(), threadId: thread.id, status: "requested", requestedAt: ctx.now };
      const userMessage: Message = {
        id: ctx.newId(),
        threadId: thread.id,
        turnId: turn.id,
        role: "user",
        text: command.text,
        createdAt: ctx.now,
      };
      return ok({ type: "turn.requested", turn, userMessage });
    }

    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return fail("invalid-command", "unknown command type");
    }
  }
}
