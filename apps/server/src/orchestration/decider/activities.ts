import type { Activity, ActivityOf, CommandOf, ReadModel } from "@tide/contracts";
import { fail, ok, type DecideContext, type DecideResult } from "./types.ts";

type ActivityCommand =
  | CommandOf<"activity.upsert">
  | CommandOf<"approval.respond">
  | CommandOf<"user-input.respond">;

const SETTLED = new Set(["completed", "interrupted", "error"]);

/**
 * Newest activity with this requestId on the thread. Harness request ids restart with the
 * process (Codex counts from 0), so an old resolved one must never shadow a live request:
 * the search walks the timeline backwards and prefers a pending match.
 */
function findPending<K extends "approval" | "user-input">(
  model: ReadModel,
  kind: K,
  threadId: string,
  requestId: string,
): ActivityOf<K> | undefined {
  let resolved: ActivityOf<K> | undefined;
  const timeline = model.threadTimeline[threadId] ?? [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    if (entry?.kind !== "activity") continue;
    const activity = model.activities[entry.id] as Activity | undefined;
    if (!activity || activity.kind !== kind || activity.requestId !== requestId) continue;
    if (activity.status === "pending") return activity as ActivityOf<K>;
    resolved ??= activity as ActivityOf<K>;
  }
  return resolved;
}

export function decideActivity(model: ReadModel, command: ActivityCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "activity.upsert": {
      const { activity } = command;
      const turn = model.turns[activity.turnId];
      if (!turn) return fail("not-found", `unknown turn ${activity.turnId}`);
      if (!model.threads[activity.threadId]) return fail("not-found", `unknown thread ${activity.threadId}`);
      if (turn.threadId !== activity.threadId) {
        return fail("conflict", `turn ${turn.id} does not belong to thread ${activity.threadId}`);
      }
      // a settled turn's prompts can never be answered: accepting one would wedge `attention`
      if (SETTLED.has(turn.status) && (activity.kind === "approval" || activity.kind === "user-input") && activity.status === "pending") {
        return fail("conflict", `turn ${turn.id} is already ${turn.status}; late ${activity.kind} ignored`);
      }
      return ok({ type: "activity.upserted", activity });
    }

    case "approval.respond": {
      const activity = findPending(model, "approval", command.threadId, command.requestId);
      if (!activity) return fail("not-found", `no approval request ${command.requestId} on thread ${command.threadId}`);
      if (activity.status === "resolved") return fail("conflict", `approval ${command.requestId} is already resolved`);
      return ok({
        type: "approval.responded",
        threadId: command.threadId,
        requestId: command.requestId,
        activityId: activity.id,
        decision: command.decision,
        at: ctx.now,
      });
    }

    case "user-input.respond": {
      const activity = findPending(model, "user-input", command.threadId, command.requestId);
      if (!activity) return fail("not-found", `no question ${command.requestId} on thread ${command.threadId}`);
      if (activity.status === "resolved") return fail("conflict", `question ${command.requestId} is already resolved`);
      return ok({
        type: "user-input.responded",
        threadId: command.threadId,
        requestId: command.requestId,
        activityId: activity.id,
        answers: command.answers,
        at: ctx.now,
      });
    }
  }
}
