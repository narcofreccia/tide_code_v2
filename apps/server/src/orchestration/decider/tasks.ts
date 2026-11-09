import type { CommandOf, DomainEvent, EventOf, ReadModel, ScheduledTask, Schedule, TaskThreadMode, Thread } from "@tide/contracts";
import { nextFireAt } from "../../scheduling/schedule.ts";
import { freshSessionEvents } from "./turns.ts";
import { fail, isArchived, ok, turnRequested, type DecideContext, type DecideResult } from "./types.ts";

type TaskCommand =
  | CommandOf<"task.create">
  | CommandOf<"task.update">
  | CommandOf<"task.delete">
  | CommandOf<"task.run-now">
  | CommandOf<"task.fire">;

type TaskPatch = EventOf<"task.updated">["patch"];

const HOOK_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * R9: a webhook's id is its URL (`POST /hook/<hookId>`), which carries no project, so it is unique
 * across every live task on this server (stricter than per project, and routing stays unambiguous).
 */
function scheduleProblem(model: ReadModel, schedule: Schedule, now: number, selfId?: string): string | undefined {
  if (schedule.kind === "once") return schedule.at > now ? undefined : "a one-time schedule must be in the future";
  if (schedule.kind === "webhook") {
    if (!HOOK_ID.test(schedule.hookId)) return "webhook hookId must be 8-64 characters of A-Z a-z 0-9 _ -";
    const taken = Object.values(model.scheduledTasks).some(
      (t) => t.id !== selfId && t.archivedAt === undefined && t.schedule.kind === "webhook" && t.schedule.hookId === schedule.hookId,
    );
    if (taken) return `webhook hookId ${schedule.hookId} is already used by another task`;
    if (schedule.secret !== undefined && schedule.secret.length === 0) return "webhook secret must not be empty (omit it instead)";
    return undefined;
  }
  if (schedule.kind === "fixed" && new Set(schedule.times).size !== schedule.times.length) return "fixed schedule times must be unique";
  if (schedule.kind === "fixed" && new Set(schedule.weekdays).size !== schedule.weekdays.length) return "fixed schedule weekdays must be unique";
  return undefined;
}

/** A task's target thread, if it has one, must still be a place a turn can land. */
function checkThread(model: ReadModel, projectId: string, threadId: string): DecideResult | Thread {
  const thread = model.threads[threadId];
  if (!thread) return fail("not-found", `unknown thread ${threadId}`);
  if (thread.projectId !== projectId) return fail("invalid-command", `thread ${threadId} belongs to another project`);
  if (isArchived(thread)) return fail("conflict", `thread ${threadId} is archived`);
  return thread;
}

/** R17: where a fire lands; absent = `continue` into the task's thread, else a new thread. */
export function threadModeOf(task: { threadId?: string; threadMode?: TaskThreadMode }): TaskThreadMode {
  return task.threadMode ?? (task.threadId !== undefined ? "continue" : "new_thread");
}

/** R17: `threadMode` must agree with `threadId` (`threadIdGiven`: the command named one itself). */
function threadModeProblem(mode: TaskThreadMode | undefined, threadId: string | undefined, threadIdGiven: boolean): string | undefined {
  if (mode === "new_thread" && threadIdGiven) return "threadMode new_thread creates a thread per run; do not pass threadId";
  if ((mode === "continue" || mode === "fresh_session") && threadId === undefined) return `threadMode ${mode} needs a threadId`;
  return undefined;
}

export function decideTask(model: ReadModel, command: TaskCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "task.create": {
      const project = model.projects[command.projectId];
      if (!project) return fail("not-found", `unknown project ${command.projectId}`);
      if (isArchived(project)) return fail("conflict", `project ${project.id} is archived`);
      const modeProblem = threadModeProblem(command.threadMode, command.threadId, command.threadId !== undefined);
      if (modeProblem !== undefined) return fail("invalid-command", modeProblem);
      if (command.threadId !== undefined) {
        const checked = checkThread(model, project.id, command.threadId);
        if ("ok" in checked) return checked;
      }
      const problem = scheduleProblem(model, command.schedule, ctx.now);
      if (problem !== undefined) return fail("invalid-command", problem);
      const nextRunAt = nextFireAt(command.schedule, ctx.now);
      const task: ScheduledTask = {
        id: ctx.newId(),
        projectId: project.id,
        ...(command.threadId !== undefined ? { threadId: command.threadId } : {}),
        ...(command.threadMode !== undefined ? { threadMode: command.threadMode } : {}),
        title: command.title,
        prompt: command.prompt,
        schedule: command.schedule,
        ...(command.provider !== undefined ? { provider: command.provider } : {}),
        ...(command.model !== undefined ? { model: command.model } : {}),
        ...(command.mode !== undefined ? { mode: command.mode } : {}),
        ...(command.useWorktree !== undefined ? { useWorktree: command.useWorktree } : {}),
        enabled: command.enabled ?? true,
        ...(command.createdByThreadId !== undefined ? { createdByThreadId: command.createdByThreadId } : {}),
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        runs: 0,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      };
      return ok({ type: "task.created", task });
    }

    case "task.update": {
      const task = model.scheduledTasks[command.taskId];
      if (!task) return fail("not-found", `unknown task ${command.taskId}`);
      if (isArchived(task)) return fail("conflict", `task ${task.id} is deleted`);
      // a stored threadId stays (a patch cannot clear it): `new_thread` then simply ignores it
      const modeProblem = threadModeProblem(command.threadMode ?? task.threadMode, command.threadId ?? task.threadId, command.threadId !== undefined);
      if (modeProblem !== undefined) return fail("invalid-command", modeProblem);
      if (command.threadId !== undefined) {
        const checked = checkThread(model, task.projectId, command.threadId);
        if ("ok" in checked) return checked;
      }
      if (command.schedule !== undefined) {
        const problem = scheduleProblem(model, command.schedule, ctx.now, task.id);
        if (problem !== undefined) return fail("invalid-command", problem);
      }
      const patch: TaskPatch = {
        ...(command.threadId !== undefined ? { threadId: command.threadId } : {}),
        ...(command.threadMode !== undefined ? { threadMode: command.threadMode } : {}),
        ...(command.title !== undefined ? { title: command.title } : {}),
        ...(command.prompt !== undefined ? { prompt: command.prompt } : {}),
        ...(command.schedule !== undefined ? { schedule: command.schedule } : {}),
        ...(command.provider !== undefined ? { provider: command.provider } : {}),
        ...(command.model !== undefined ? { model: command.model } : {}),
        ...(command.mode !== undefined ? { mode: command.mode } : {}),
        ...(command.useWorktree !== undefined ? { useWorktree: command.useWorktree } : {}),
        ...(command.enabled !== undefined ? { enabled: command.enabled } : {}),
      };
      const rearmed = task.completedAt !== undefined && !task.enabled;
      if (rearmed && command.enabled === true && command.schedule === undefined && task.schedule.kind === "once") {
        return fail("invalid-command", "this one-time task already ran; pick a new time to run it again");
      }
      // a finished one-time task is armed again by giving it a new time
      if (rearmed && command.schedule?.kind === "once" && command.enabled === undefined) patch.enabled = true;
      // a new schedule, or switching a paused task back on, must not fire off a stale slot
      const reschedule = command.schedule !== undefined || (command.enabled === true && !task.enabled);
      if (reschedule) {
        const next = nextFireAt(command.schedule ?? task.schedule, ctx.now);
        if (next !== undefined) patch.nextRunAt = next;
      }
      return ok({ type: "task.updated", taskId: task.id, patch, updatedAt: ctx.now });
    }

    case "task.delete": {
      const task = model.scheduledTasks[command.taskId];
      if (!task) return fail("not-found", `unknown task ${command.taskId}`);
      if (isArchived(task)) return ok();
      return ok({ type: "task.deleted", taskId: task.id, at: ctx.now });
    }

    case "task.run-now": {
      const task = model.scheduledTasks[command.taskId];
      if (!task) return fail("not-found", `unknown task ${command.taskId}`);
      if (isArchived(task)) return fail("conflict", `task ${task.id} is deleted`);
      return fire(model, task, ctx, undefined, undefined, undefined, false);
    }

    case "task.fire": {
      const task = model.scheduledTasks[command.taskId];
      if (!task) return fail("not-found", `unknown task ${command.taskId}`);
      if (isArchived(task)) return fail("conflict", `task ${task.id} is deleted`);
      // the scheduler may race an update that paused the task
      if (!task.enabled) return ok();
      return fire(model, task, ctx, command.nextRunAt, command.useWorktreeDefault, command.promptSuffix, true);
    }
  }
}

function fire(
  model: ReadModel,
  task: ScheduledTask,
  ctx: DecideContext,
  nextRunAt: number | undefined,
  useWorktreeDefault: boolean | undefined,
  promptSuffix: string | undefined,
  /** a clock/webhook fire, as opposed to "Run now" */
  scheduled: boolean,
): DecideResult {
  const notification = { source: "schedule" as const, summary: `${task.schedule.kind === "webhook" ? "webhook" : "scheduled"}: ${task.title}` };
  const events: DomainEvent[] = [];
  let thread: Thread | undefined;
  const mode = threadModeOf(task);
  if (mode !== "new_thread" && task.threadId !== undefined) {
    const checked = checkThread(model, task.projectId, task.threadId);
    if ("ok" in checked) return checked;
    thread = checked;
    if (thread.rollback?.status === "rolling") return fail("busy", `thread ${thread.id} is rolling back`);
    if (thread.worktreePath === undefined && thread.branch !== undefined) {
      return fail("conflict", `thread ${thread.id} has no worktree any more; archive it or start a new thread`);
    }
  }
  let threadId: string;
  let queued = false;
  let handoffId: string | undefined;
  if (thread) {
    threadId = thread.id;
    queued = thread.status === "running";
    handoffId = thread.pendingHandoffId;
  } else {
    const siblings = Object.values(model.threads)
      .filter((t) => t.projectId === task.projectId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const created: Thread = {
      id: ctx.newId(),
      projectId: task.projectId,
      title: task.title,
      provider: task.provider ?? siblings[0]?.provider ?? "claude",
      ...(task.model !== undefined ? { model: task.model } : {}),
      mode: task.mode ?? "approval-required",
      interaction: "default",
      status: "idle",
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    threadId = created.id;
    events.push({ type: "thread.created", thread: created, useWorktree: task.useWorktree ?? useWorktreeDefault ?? true });
  }
  const prompt = promptSuffix !== undefined && promptSuffix.length > 0 ? `${task.prompt}\n\n${promptSuffix}` : task.prompt;
  const requested = turnRequested(threadId, prompt, ctx, notification);
  const turn = {
    ...requested.turn,
    ...(queued ? { status: "queued" as const } : {}),
    ...(handoffId !== undefined ? { handoffId } : {}),
  };
  if (mode === "fresh_session" && thread) {
    // busy, not conflict: the scheduler retries a busy fire on its next tick instead of skipping the slot
    const fresh = freshSessionEvents(thread, { ...requested, turn }, ctx);
    if ("refused" in fresh) return fail("busy", fresh.refused);
    events.push(...fresh.events);
  } else events.push({ ...requested, turn });
  const once = scheduled && task.schedule.kind === "once";
  events.push({
    type: "task.fired",
    taskId: task.id,
    threadId,
    turnId: turn.id,
    ...(nextRunAt !== undefined && !once ? { nextRunAt } : {}),
    at: ctx.now,
  });
  // a one-time task is done after its fire; nextRunAt keeps the slot it fired for (clearing a key does not survive the event log)
  if (once) events.push({ type: "task.updated", taskId: task.id, patch: { enabled: false, completedAt: ctx.now }, updatedAt: ctx.now });
  return ok(...events);
}
