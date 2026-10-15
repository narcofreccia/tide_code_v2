import type { CommandOf, DomainEvent, EventOf, ReadModel, ScheduledTask, Schedule, Thread } from "@tide/contracts";
import { nextFireAt } from "../../scheduling/schedule.ts";
import { fail, isArchived, ok, turnRequested, type DecideContext, type DecideResult } from "./types.ts";

type TaskCommand =
  | CommandOf<"task.create">
  | CommandOf<"task.update">
  | CommandOf<"task.delete">
  | CommandOf<"task.run-now">
  | CommandOf<"task.fire">;

type TaskPatch = EventOf<"task.updated">["patch"];

function scheduleProblem(schedule: Schedule): string | undefined {
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

export function decideTask(model: ReadModel, command: TaskCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "task.create": {
      const project = model.projects[command.projectId];
      if (!project) return fail("not-found", `unknown project ${command.projectId}`);
      if (isArchived(project)) return fail("conflict", `project ${project.id} is archived`);
      if (command.threadId !== undefined) {
        const checked = checkThread(model, project.id, command.threadId);
        if ("ok" in checked) return checked;
      }
      const problem = scheduleProblem(command.schedule);
      if (problem !== undefined) return fail("invalid-command", problem);
      const nextRunAt = nextFireAt(command.schedule, ctx.now);
      const task: ScheduledTask = {
        id: ctx.newId(),
        projectId: project.id,
        ...(command.threadId !== undefined ? { threadId: command.threadId } : {}),
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
      if (command.threadId !== undefined) {
        const checked = checkThread(model, task.projectId, command.threadId);
        if ("ok" in checked) return checked;
      }
      if (command.schedule !== undefined) {
        const problem = scheduleProblem(command.schedule);
        if (problem !== undefined) return fail("invalid-command", problem);
      }
      const patch: TaskPatch = {
        ...(command.threadId !== undefined ? { threadId: command.threadId } : {}),
        ...(command.title !== undefined ? { title: command.title } : {}),
        ...(command.prompt !== undefined ? { prompt: command.prompt } : {}),
        ...(command.schedule !== undefined ? { schedule: command.schedule } : {}),
        ...(command.provider !== undefined ? { provider: command.provider } : {}),
        ...(command.model !== undefined ? { model: command.model } : {}),
        ...(command.mode !== undefined ? { mode: command.mode } : {}),
        ...(command.useWorktree !== undefined ? { useWorktree: command.useWorktree } : {}),
        ...(command.enabled !== undefined ? { enabled: command.enabled } : {}),
      };
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
      return fire(model, task, ctx, undefined, undefined);
    }

    case "task.fire": {
      const task = model.scheduledTasks[command.taskId];
      if (!task) return fail("not-found", `unknown task ${command.taskId}`);
      if (isArchived(task)) return fail("conflict", `task ${task.id} is deleted`);
      // the scheduler may race an update that paused the task
      if (!task.enabled) return ok();
      return fire(model, task, ctx, command.nextRunAt, command.useWorktreeDefault);
    }
  }
}

function fire(
  model: ReadModel,
  task: ScheduledTask,
  ctx: DecideContext,
  nextRunAt: number | undefined,
  useWorktreeDefault: boolean | undefined,
): DecideResult {
  const notification = { source: "schedule" as const, summary: `scheduled: ${task.title}` };
  const events: DomainEvent[] = [];
  let thread: Thread | undefined;
  if (task.threadId !== undefined) {
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
  const requested = turnRequested(threadId, task.prompt, ctx, notification);
  const turn = {
    ...requested.turn,
    ...(queued ? { status: "queued" as const } : {}),
    ...(handoffId !== undefined ? { handoffId } : {}),
  };
  events.push({ ...requested, turn });
  events.push({
    type: "task.fired",
    taskId: task.id,
    threadId,
    turnId: turn.id,
    ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    at: ctx.now,
  });
  return ok(...events);
}
