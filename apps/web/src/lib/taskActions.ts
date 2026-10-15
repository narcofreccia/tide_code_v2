import type { ClientCommand, ScheduledTask } from "@tide/contracts";
import { newId } from "@tide/contracts";
import { dispatch, type DispatchResult } from "../state/model.ts";

export type TaskFields = Pick<ScheduledTask, "title" | "prompt" | "schedule"> &
  Partial<Pick<ScheduledTask, "threadId" | "provider" | "model" | "mode" | "useWorktree" | "enabled">>;

type Send = (command: ClientCommand) => Promise<DispatchResult>;

/** Each helper stamps a fresh `commandId` so a retried click cannot double-apply. */
export function createTask(projectId: string, fields: TaskFields, send: Send = dispatch): Promise<DispatchResult> {
  return send({ type: "task.create", commandId: newId(), projectId, ...fields });
}

export function updateTask(taskId: string, patch: Partial<TaskFields>, send: Send = dispatch): Promise<DispatchResult> {
  return send({ type: "task.update", commandId: newId(), taskId, ...patch });
}

export function deleteTask(taskId: string, send: Send = dispatch): Promise<DispatchResult> {
  return send({ type: "task.delete", commandId: newId(), taskId });
}

export function runTaskNow(taskId: string, send: Send = dispatch): Promise<DispatchResult> {
  return send({ type: "task.run-now", commandId: newId(), taskId });
}
