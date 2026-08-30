import type { Activity, ActivityOf, CommandOf, ReadModel } from "@tide/contracts";
import { fail, ok, type DecideContext, type DecideResult } from "./types.ts";

type ActivityCommand =
  | CommandOf<"activity.upsert">
  | CommandOf<"approval.respond">
  | CommandOf<"user-input.respond">;

function findPending<K extends "approval" | "user-input">(
  model: ReadModel,
  kind: K,
  threadId: string,
  requestId: string,
): ActivityOf<K> | undefined {
  for (const activity of Object.values(model.activities) as Activity[]) {
    if (activity.kind !== kind) continue;
    if (activity.threadId !== threadId) continue;
    if (activity.requestId !== requestId) continue;
    return activity as ActivityOf<K>;
  }
  return undefined;
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
        answers: command.answers,
        at: ctx.now,
      });
    }
  }
}
