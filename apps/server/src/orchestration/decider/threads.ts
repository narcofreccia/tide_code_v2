import type { CommandOf, DomainEvent, LinkAccess, Project, ReadModel, Thread } from "@tide/contracts";
import { handoffTurns } from "../handoff/select.ts";
import { DEFAULT_THREAD_TITLE } from "./autoTitle.ts";
import { descendantsOf } from "./descendants.ts";
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
  | CommandOf<"thread.unarchive">
  | CommandOf<"thread.delete">
  | CommandOf<"thread.triage">
  | CommandOf<"thread.limited">
  | CommandOf<"thread.limit-policy">
  | CommandOf<"thread.snooze">
  | CommandOf<"thread.settle">
  | CommandOf<"thread.unsettle">
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
        title: command.title ?? DEFAULT_THREAD_TITLE,
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
      const patch: Partial<Pick<Thread, "title" | "provider" | "model" | "mode" | "interaction" | "pinned" | "autoAllowRoutine" | "autoSettle">> = {
        ...(command.title !== undefined ? { title: command.title } : {}),
        ...(command.provider !== undefined ? { provider: command.provider } : {}),
        ...(command.model !== undefined ? { model: command.model } : {}),
        ...(command.mode !== undefined ? { mode: command.mode } : {}),
        ...(command.interaction !== undefined ? { interaction: command.interaction } : {}),
        ...(command.pinned !== undefined ? { pinned: command.pinned } : {}),
        ...(command.autoAllowRoutine !== undefined ? { autoAllowRoutine: command.autoAllowRoutine } : {}),
        ...(command.autoSettle !== undefined ? { autoSettle: command.autoSettle } : {}),
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

    case "thread.unarchive": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (!isArchived(thread)) return ok(); // idempotent
      const project = model.projects[thread.projectId];
      if (!project) return fail("not-found", `unknown project ${thread.projectId}`);
      if (isArchived(project)) return fail("conflict", `project ${project.id} is archived; unarchive it first`);
      return ok({ type: "thread.unarchived", threadId: thread.id, at: ctx.now });
    }

    case "thread.delete": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (thread.status === "running") return fail("busy", `thread ${thread.id} is running`);
      // lineage would dangle: descendants (archived or not) go first, or along with it
      const descendants = descendantsOf(model, thread.id);
      if (descendants.length > 0 && command.cascade !== true) {
        return fail("conflict", childrenMessage(thread, descendants));
      }
      const doomed = [...descendants, thread];
      for (const t of descendants) {
        if (t.status === "running") return fail("busy", `descendant thread "${t.title}" (${t.id}) is running`);
      }
      const ids = new Set(doomed.map((t) => t.id));
      for (const t of doomed) {
        const refused = deleteRefusal(model, t, ids);
        if (refused !== undefined) return fail("conflict", refused);
      }
      return ok(...doomed.map((t): DomainEvent => ({
        type: "thread.deleted",
        threadId: t.id,
        projectId: t.projectId,
        ...(t.worktreePath !== undefined ? { worktreePath: t.worktreePath } : {}),
        ...(t.branch !== undefined ? { branch: t.branch } : {}),
        at: ctx.now,
      })));
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
          // a policy the user already chose for this thread wins over the global setting
          resume: thread.limited?.resume ?? ctx.limitPolicy ?? "manual",
          at: ctx.now,
        },
      });
    }

    case "thread.limit-policy": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      return ok({ type: "thread.limit-policy-changed", threadId: thread.id, resume: command.resume, at: ctx.now });
    }

    case "thread.settle": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (isArchived(thread)) return fail("conflict", `thread ${thread.id} is archived`);
      if (thread.settledAt !== undefined) return ok(); // idempotent
      const reason = command.reason ?? "user";
      // the server's own rules never close something that is working or waiting on the user
      if (reason !== "user" && (thread.status === "running" || thread.attention !== undefined || thread.pinned === true || thread.autoSettle === false)) {
        return fail("conflict", `thread ${thread.id} is not settleable automatically`);
      }
      return ok({ type: "thread.settled", threadId: thread.id, reason, at: ctx.now });
    }

    case "thread.unsettle": {
      const thread = model.threads[command.threadId];
      if (!thread) return fail("not-found", `unknown thread ${command.threadId}`);
      if (thread.settledAt === undefined) return ok();
      return ok({ type: "thread.unsettled", threadId: thread.id, at: ctx.now });
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

/** `thread "Fix" still has 2 child threads (“a”, “b”); delete them too (cascade) or first` — titles of direct children first, at most 3. */
function childrenMessage(thread: Thread, descendants: Thread[]): string {
  const direct = (t: Thread): boolean => t.parentThreadId === thread.id || t.delegatedBy === thread.id;
  const ordered = [...descendants.filter(direct), ...descendants.filter((t) => !direct(t))];
  const shown = ordered.slice(0, 3).map((t) => `“${t.title}”`);
  if (ordered.length > shown.length) shown.push(`+${ordered.length - shown.length} more`);
  const noun = ordered.length === 1 ? "child thread" : "child threads";
  return `thread "${thread.title}" still has ${ordered.length} ${noun} (${shown.join(", ")}); delete them too (cascade) or first`;
}

/** Why `thread` cannot be deleted along with the threads in `deleting`, if anything stops it. */
function deleteRefusal(model: ReadModel, thread: Thread, deleting: Set<string>): string | undefined {
  // same rule as vcs/restore.ts `sharingThread`: removing the worktree would pull it from under a
  // live thread; a thread deleted in the same cascade (a delegate on the lead's checkout) does not count
  if (thread.worktreePath !== undefined && Object.values(model.threads).some((t) =>
    !deleting.has(t.id) && t.archivedAt === undefined && t.worktreePath === thread.worktreePath)) {
    return `another live thread shares the worktree of thread ${thread.id}; archive it first`;
  }
  if (thread.expertsSessionId !== undefined) {
    const session = model.expertsSessions[thread.expertsSessionId];
    if (session && session.phase !== "archived") {
      return deleting.size > 1
        ? `thread "${thread.title}" belongs to a live Experts session; archive the session first`
        : "thread belongs to a live Experts session; archive the session first";
    }
  }
  return undefined;
}
