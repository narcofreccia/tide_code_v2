import type { ModelMapKey } from "@tide/client";
import type { RouteOptions } from "./model.ts";

/**
 * R9 routing: which environment answers a call, a command or a stream.
 *
 *   1. an explicit `opts.envId`
 *   2. the owner of the first id field (in this order) whose owner is known:
 *      threadId, parentThreadId, fromThreadId, createdByThreadId (thread),
 *      projectId (project), taskId (scheduled task), turnId (turn), planId (plan),
 *      sessionId (experts session), ptyId (the env that created / listed the pty)
 *   3. the primary environment
 *
 * A field whose owner is unknown (a brand-new id, an id no environment reported yet)
 * falls through to the next field, so `thread.create` (new thread, existing project)
 * routes by its project.
 */
export const ROUTE_FIELDS: readonly (readonly [string, ModelMapKey | "ptys"])[] = [
  ["threadId", "threads"],
  ["parentThreadId", "threads"],
  ["fromThreadId", "threads"],
  ["createdByThreadId", "threads"],
  ["projectId", "projects"],
  ["taskId", "scheduledTasks"],
  ["turnId", "turns"],
  ["planId", "plans"],
  ["sessionId", "expertsSessions"],
  ["ptyId", "ptys"],
];

export interface RouteContext {
  primaryId: string | undefined;
  ownerOf: (kind: ModelMapKey | "ptys", id: string) => string | undefined;
}

export function routeEnv(subject: unknown, opts: RouteOptions | undefined, ctx: RouteContext): string | undefined {
  if (opts?.envId !== undefined) return opts.envId;
  if (typeof subject === "object" && subject !== null) {
    const fields = subject as Record<string, unknown>;
    for (const [field, kind] of ROUTE_FIELDS) {
      const id = fields[field];
      if (typeof id !== "string" || id === "") continue;
      const owner = ctx.ownerOf(kind, id);
      if (owner !== undefined) return owner;
    }
  }
  return ctx.primaryId;
}
