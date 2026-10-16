import type { CommandOf, ReadModel } from "@tide/contracts";
import { fail, ok, type DecideContext, type DecideResult } from "./types.ts";

type JudgeCommand = CommandOf<"judge.record"> | CommandOf<"handoff.refine">;

/**
 * R6: verdicts from the decision layer. `judge.record` annotates a thread, an approval activity
 * or an experts session; `handoff.refine` replaces a pending handoff's selection with the
 * judge's, only while no turn has delivered it yet (a requested turn may still be waiting on it).
 */
export function decideJudge(model: ReadModel, command: JudgeCommand, ctx: DecideContext): DecideResult {
  switch (command.type) {
    case "judge.record": {
      const { target, verdict } = command;
      if (target.kind === "thread" && !model.threads[target.id]) return fail("not-found", `unknown thread ${target.id}`);
      if (target.kind === "experts" && !model.expertsSessions[target.id]) return fail("not-found", `unknown experts session ${target.id}`);
      if (target.kind === "approval") {
        const activity = model.activities[target.id];
        if (!activity) return fail("not-found", `unknown activity ${target.id}`);
        if (activity.kind !== "approval") return fail("invalid-command", `activity ${target.id} is not an approval`);
      }
      return ok({ type: "judge.recorded", target, verdict });
    }

    case "handoff.refine": {
      const handoff = model.handoffs[command.handoffId];
      if (!handoff) return fail("not-found", `unknown handoff ${command.handoffId}`);
      const thread = model.threads[handoff.threadId];
      if (!thread) return fail("not-found", `unknown thread ${handoff.threadId}`);
      // pending on the thread, or taken by a turn that has not delivered it yet (the provider
      // reactor waits briefly for the judge before delivering)
      const takers = Object.values(model.turns).filter((t) => t.handoffId === handoff.id);
      const delivered = takers.some((t) => t.handoffDelivery !== undefined || t.settledAt !== undefined);
      const pending = thread.pendingHandoffId === handoff.id || takers.length > 0;
      if (!pending || delivered) return fail("conflict", `handoff ${handoff.id} is no longer pending`);
      return ok({
        type: "handoff.refined",
        handoffId: handoff.id,
        threadId: handoff.threadId,
        text: command.text,
        coveredTurnIds: command.coveredTurnIds,
        omittedTurnIds: command.omittedTurnIds,
        judge: command.judge,
        at: ctx.now,
      });
    }
  }
}
