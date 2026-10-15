import type { CommandOf, DomainEvent, LinkAccess, Project, ReadModel, Thread } from "@tide/contracts";
import { handoffTurns } from "../handoff/select.ts";
import { recordHandoff } from "./handoff.ts";
import { fail, isArchived, ok, turnRequested, type DecideContext, type DecideResult } from "./types.ts";

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
  | CommandOf<"thread.archive">
  | CommandOf<"thread.triage">
  | CommandOf<"thread.limited">
  | CommandOf<"thread.limit-policy">
  | CommandOf<"thread.snooze">
  | CommandOf<"thread.resume">
  | CommandOf<"pr.watch">;

const CONTINUE_PROMPT = "Continue where you left off.";

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
      const toProvider = command.provider;
      if (toProvider === undefined || toProvider === thread.provider) {
        return ok({ type: "thread.updated", threadId: thread.id, patch, updatedAt: ctx.now });
      }
      if (thread.status === "running") return fail("busy", `thread ${thread.id} is running; switch provider once it settles`);
      if (thread.rollback?.status === "rolling") return fail("busy", `thread ${thread.id} is rolling back`);
      // a harness that already ran this thread resumes its own session and only needs what
      // happened since; any other starts fresh and gets the whole (budgeted) history
      const known = thread.providerSessions?.[toProvider];
      const strategy = known !== undefined ? "delta" : "full";
      const turns = handoffTurns(model, thread.id, { sinceTurnId: known?.lastTurnId });
      const events: DomainEvent[] = [{
        type: "thread.updated",
        threadId: thread.id,
        patch,
        ...(known !== undefined ? { nativeSessionId: known.nativeSessionId } : { clearNativeSession: true }),
        // a model id belongs to one harness: without a new one the target runs on its default
        ...(command.model === undefined && thread.model !== undefined ? { clearModel: true } : {}),
        updatedAt: ctx.now,
      }];
      if (turns.length > 0) {
        events.push(recordHandoff(model, { threadId: thread.id, source: thread, fromProvider: thread.provider, toProvider, strategy, turns }, ctx));
      }
      return ok(...events);
    }

    case "thread.triage": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(thread)) return ok();
      return ok({ type: "thread.triaged", threadId: thread.id, triage: command.triage });
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

    case "thread.limited": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      return ok({
        type: "thread.limited",
        threadId: thread.id,
        limited: {
          ...(command.resetsAt !== undefined ? { resetsAt: command.resetsAt } : {}),
          ...(command.note !== undefined ? { note: command.note } : {}),
          resume: thread.limited?.resume ?? "manual",
          at: ctx.now,
        },
      });
    }

    case "thread.limit-policy": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      return ok({ type: "thread.limit-policy-changed", threadId: thread.id, resume: command.resume, at: ctx.now });
    }

    case "thread.snooze": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (command.until <= ctx.now) return fail("invalid-command", "snooze must end in the future");
      return ok({ type: "thread.snoozed", threadId: thread.id, until: command.until, at: ctx.now });
    }

    case "thread.resume": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(thread)) return fail("conflict", `thread ${thread.id} is archived`);
      if (thread.status === "running") return fail("busy", `thread ${thread.id} is running`);
      const resumeTurn = command.continue === true;
      if (!resumeTurn && thread.limited === undefined && thread.snoozedUntil === undefined) {
        return fail("conflict", `thread ${thread.id} is neither limited nor snoozed`);
      }
      if (resumeTurn && thread.worktreePath === undefined && thread.branch !== undefined) {
        return fail("conflict", `thread ${thread.id} has no worktree any more; archive it or start a new thread`);
      }
      const resumed: DomainEvent = { type: "thread.resumed", threadId: thread.id, at: ctx.now };
      if (!resumeTurn) return ok(resumed);
      const requested = turnRequested(thread.id, CONTINUE_PROMPT, ctx, { source: "restart", summary: "resumed by the user" });
      // like turn.request: a pending handoff rides on the next turn
      const turn = thread.pendingHandoffId !== undefined ? { ...requested.turn, handoffId: thread.pendingHandoffId } : requested.turn;
      return ok(resumed, { ...requested, turn });
    }

    case "pr.watch": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (command.enabled && thread.pr === undefined) return fail("conflict", `thread ${thread.id} has no pull request to watch`);
      return ok({ type: "pr.watch-changed", threadId: thread.id, enabled: command.enabled, at: ctx.now });
    }
  }
}
